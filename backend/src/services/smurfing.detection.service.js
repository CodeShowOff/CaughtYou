const { smurfing: smurfCfg } = require('../config/detectors');

const {
  SMURFING_THRESHOLD,
  TIME_WINDOW_HOURS,
  LOW_VELOCITY_DURATION_HOURS,
  LOW_VELOCITY_RATE,
  PAYROLL_MIN_OUT_EDGES,
  PAYROLL_MAX_COV,
  MERCHANT_MIN_SENDERS,
  MERCHANT_MAX_RECV_RATIO,
  FANIN_AMOUNT_CV_MAX,
  FANIN_MIN_MEDIAN,
  FANOUT_AMOUNT_CV_MAX,
  FANOUT_MIN_MEDIAN,
} = smurfCfg;

const TIME_WINDOW_MS = TIME_WINDOW_HOURS * 60 * 60 * 1000;

const BENIGN_ID_PATTERNS = [
  /^PAYROLL/i,
  /^MERCHANT/i,
  /^SALARY/i,
  /^VENDOR/i,
  /^SUPPLIER/i,
  /^GOV/i,
  /^TREASURY/i,
  /^UTILITY/i,
  /^INSURANCE/i,
];

const matchesBenignIdPattern = (accountId) => {
  if (accountId == null) return false;
  return BENIGN_ID_PATTERNS.some((re) => re.test(String(accountId)));
};

/**
 * Heuristic: classify account as likely payroll distributor.
 * Uses both name-pattern matching AND behavioral signals:
 * - Must have enough outgoing edges
 * - Outgoing amounts should be regular (low CoV)
 * - Optionally: recurring schedule (similar time gaps between transactions)
 */
const isLikelyPayroll = (accountId, velocityMetrics, outgoingEdges) => {
  // Name-pattern gives a confidence boost but is not sufficient alone
  const nameMatch = matchesBenignIdPattern(accountId);

  const v = velocityMetrics.get(accountId);
  if (!v) return false; // require behavioral data, name-only is insufficient

  const outEdges = outgoingEdges.get(accountId) || [];
  if (outEdges.length < PAYROLL_MIN_OUT_EDGES) return false;

  const amounts = outEdges.map((e) => e.amount);
  const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
  if (mean === 0) return false;

  const variance =
    amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length;
  const cov = Math.sqrt(variance) / mean;

  // Behavioral: regular amounts (low CoV)
  const hasRegularAmounts = cov < PAYROLL_MAX_COV;

  // Behavioral: check for recurring schedule (regular time gaps)
  let hasRegularSchedule = false;
  if (outEdges.length >= 3) {
    const sortedTimes = outEdges
      .filter((e) => e.timestamp)
      .map((e) => e.timestamp.getTime())
      .sort((a, b) => a - b);
    if (sortedTimes.length >= 3) {
      const gaps = [];
      for (let i = 1; i < sortedTimes.length; i++) {
        gaps.push(sortedTimes[i] - sortedTimes[i - 1]);
      }
      const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      if (meanGap > 0) {
        const gapVariance = gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / gaps.length;
        const gapCov = Math.sqrt(gapVariance) / meanGap;
        hasRegularSchedule = gapCov < 0.5; // regular schedule if time gaps are consistent
      }
    }
  }

  // Name match + any behavioral signal = payroll
  if (nameMatch && (hasRegularAmounts || hasRegularSchedule)) return true;
  // Strong behavioral: both regular amounts AND regular schedule (even without name match)
  if (hasRegularAmounts && hasRegularSchedule && v.active_duration_hours >= LOW_VELOCITY_DURATION_HOURS) return true;
  // Name match alone with sufficient duration
  if (nameMatch && v.active_duration_hours >= LOW_VELOCITY_DURATION_HOURS) return true;

  return false;
};

/**
 * Heuristic: classify account as likely merchant / payment receiver.
 * Uses both name-pattern matching AND behavioral signals:
 * - Must have many unique senders (diverse customer base)
 * - Few outgoing edges relative to incoming (receives >> sends)
 * - Optionally: regular incoming amounts (product pricing)
 */
const isLikelyMerchant = (accountId, velocityMetrics, incomingEdges, outgoingEdges) => {
  const nameMatch = matchesBenignIdPattern(accountId);

  const v = velocityMetrics.get(accountId);
  if (!v) return false; // require behavioral data, name-only is insufficient

  const inEdges = incomingEdges.get(accountId) || [];
  const outEdges = outgoingEdges.get(accountId) || [];

  const uniqueSenders = new Set(inEdges.map((e) => e.from)).size;
  const uniqueReceivers = new Set(outEdges.map((e) => e.to)).size;

  // Behavioral: many senders, few receivers (merchant pattern)
  const hasMerchantTrafficPattern =
    uniqueSenders >= MERCHANT_MIN_SENDERS &&
    uniqueReceivers <= uniqueSenders * MERCHANT_MAX_RECV_RATIO;

  // Behavioral: check if incoming amounts cluster around common values (pricing tiers)
  let hasConsistentPricing = false;
  if (inEdges.length >= 5) {
    const inAmounts = inEdges.map((e) => e.amount).sort((a, b) => a - b);
    // Check if a significant fraction of amounts repeat
    const amountFreq = new Map();
    for (const a of inAmounts) {
      const rounded = Math.round(a * 100) / 100;
      amountFreq.set(rounded, (amountFreq.get(rounded) || 0) + 1);
    }
    const maxFreq = Math.max(...amountFreq.values());
    hasConsistentPricing = maxFreq / inAmounts.length >= 0.3; // 30%+ same amount
  }

  // Name match + traffic pattern = merchant
  if (nameMatch && hasMerchantTrafficPattern) return true;
  // Strong behavioral: merchant traffic + consistent pricing + long duration
  if (hasMerchantTrafficPattern && hasConsistentPricing && v.active_duration_hours >= LOW_VELOCITY_DURATION_HOURS) return true;
  // Name match alone with sufficient duration
  if (nameMatch && v.active_duration_hours >= LOW_VELOCITY_DURATION_HOURS) return true;

  return false;
};

const isLowVelocityAccount = (accountId, velocityMetrics) => {
  const v = velocityMetrics.get(accountId);
  if (!v) return false;

  // Guard: if LOW_VELOCITY_DURATION_HOURS is 0, skip velocity rate check
  // to avoid division by zero (config-sensitivity).
  if (LOW_VELOCITY_DURATION_HOURS <= 0) return false;

  return (
    v.active_duration_hours > LOW_VELOCITY_DURATION_HOURS &&
    v.total_transactions / v.active_duration_hours < LOW_VELOCITY_RATE
  );
};

const detectFanIn = (accountId, txns) => {
  const senderFreq = new Map();
  const senderAmounts = new Map(); // track total amounts per sender
  let uniqueSenders = 0;
  let left = 0;

  let bestMembers = null;
  let bestCount = 0;
  let bestWindowStart = null;
  let bestWindowEnd = null;
  let bestTotalAmount = 0;
  let bestAmountPerSender = new Map();

  for (let right = 0; right < txns.length; right++) {
    const sender = txns[right].sender_id;
    // Exclude self-transfers from fan-in detection
    if (sender === accountId) continue;

    const prevCount = senderFreq.get(sender) || 0;
    if (prevCount === 0) uniqueSenders++;
    senderFreq.set(sender, prevCount + 1);
    senderAmounts.set(sender, (senderAmounts.get(sender) || 0) + (txns[right].amount || 0));

    while (
      txns[right].timestamp.getTime() - txns[left].timestamp.getTime() >
      TIME_WINDOW_MS
    ) {
      const lSender = txns[left].sender_id;
      if (lSender !== accountId) {
        const newCount = senderFreq.get(lSender) - 1;
        if (newCount === 0) {
          senderFreq.delete(lSender);
          uniqueSenders--;
          senderAmounts.delete(lSender);
        } else {
          senderFreq.set(lSender, newCount);
          senderAmounts.set(lSender, (senderAmounts.get(lSender) || 0) - (txns[left].amount || 0));
        }
      }
      left++;
    }

    if (uniqueSenders >= SMURFING_THRESHOLD) {
      if (!bestMembers || uniqueSenders > bestCount) {
        bestCount = uniqueSenders;
        bestMembers = [];
        bestAmountPerSender = new Map();
        bestTotalAmount = 0;
        for (const [senderId, count] of senderFreq) {
          if (count > 0) {
            bestMembers.push(senderId);
            const amt = senderAmounts.get(senderId) || 0;
            bestAmountPerSender.set(senderId, amt);
            bestTotalAmount += amt;
          }
        }
        bestWindowStart = txns[left].timestamp;
        bestWindowEnd = txns[right].timestamp;
      }
    }
  }

  if (!bestMembers) return null;

  // Compute amount statistics for the best window
  const amounts = [...bestAmountPerSender.values()];
  const meanAmount = amounts.length > 0 ? amounts.reduce((s, a) => s + a, 0) / amounts.length : 0;

  // Amount dispersion filter: reject windows with high CV (crowdfunding/marketplace noise)
  if (FANIN_AMOUNT_CV_MAX > 0 && amounts.length >= 2 && meanAmount > 0) {
    const variance = amounts.reduce((s, a) => s + (a - meanAmount) ** 2, 0) / amounts.length;
    const cv = Math.sqrt(variance) / meanAmount;
    if (cv > FANIN_AMOUNT_CV_MAX) return null;
  }

  // Minimum median filter: reject windows with tiny amounts (microtransactions)
  if (FANIN_MIN_MEDIAN > 0 && amounts.length > 0) {
    const sorted = [...amounts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median < FANIN_MIN_MEDIAN) return null;
  }

  return {
    members: bestMembers.sort(),
    windowStart: bestWindowStart,
    windowEnd: bestWindowEnd,
    uniqueCount: bestCount,
    totalAmount: bestTotalAmount,
    meanAmountPerSender: Number(meanAmount.toFixed(2)),
  };
};

const detectFanOut = (accountId, txns) => {
  const receiverFreq = new Map();
  const receiverAmounts = new Map(); // track total amounts per receiver
  let uniqueReceivers = 0;
  let left = 0;

  let bestMembers = null;
  let bestCount = 0;
  let bestWindowStart = null;
  let bestWindowEnd = null;
  let bestTotalAmount = 0;
  let bestAmountPerReceiver = new Map();

  for (let right = 0; right < txns.length; right++) {
    const receiver = txns[right].receiver_id;
    // Exclude self-transfers from fan-out detection
    if (receiver === accountId) continue;

    const prevCount = receiverFreq.get(receiver) || 0;
    if (prevCount === 0) uniqueReceivers++;
    receiverFreq.set(receiver, prevCount + 1);
    receiverAmounts.set(receiver, (receiverAmounts.get(receiver) || 0) + (txns[right].amount || 0));

    while (
      txns[right].timestamp.getTime() - txns[left].timestamp.getTime() >
      TIME_WINDOW_MS
    ) {
      const lReceiver = txns[left].receiver_id;
      if (lReceiver !== accountId) {
        const newCount = receiverFreq.get(lReceiver) - 1;
        if (newCount === 0) {
          receiverFreq.delete(lReceiver);
          uniqueReceivers--;
          receiverAmounts.delete(lReceiver);
        } else {
          receiverFreq.set(lReceiver, newCount);
          receiverAmounts.set(lReceiver, (receiverAmounts.get(lReceiver) || 0) - (txns[left].amount || 0));
        }
      }
      left++;
    }

    if (uniqueReceivers >= SMURFING_THRESHOLD) {
      if (!bestMembers || uniqueReceivers > bestCount) {
        bestCount = uniqueReceivers;
        bestMembers = [];
        bestAmountPerReceiver = new Map();
        bestTotalAmount = 0;
        for (const [receiverId, count] of receiverFreq) {
          if (count > 0) {
            bestMembers.push(receiverId);
            const amt = receiverAmounts.get(receiverId) || 0;
            bestAmountPerReceiver.set(receiverId, amt);
            bestTotalAmount += amt;
          }
        }
        bestWindowStart = txns[left].timestamp;
        bestWindowEnd = txns[right].timestamp;
      }
    }
  }

  if (!bestMembers) return null;

  // Compute amount statistics for the best window
  const amounts = [...bestAmountPerReceiver.values()];
  const meanAmount = amounts.length > 0 ? amounts.reduce((s, a) => s + a, 0) / amounts.length : 0;

  // Amount dispersion filter: reject windows with high CV
  if (FANOUT_AMOUNT_CV_MAX > 0 && amounts.length >= 2 && meanAmount > 0) {
    const variance = amounts.reduce((s, a) => s + (a - meanAmount) ** 2, 0) / amounts.length;
    const cv = Math.sqrt(variance) / meanAmount;
    if (cv > FANOUT_AMOUNT_CV_MAX) return null;
  }

  // Minimum median filter: reject windows with tiny amounts
  if (FANOUT_MIN_MEDIAN > 0 && amounts.length > 0) {
    const sorted = [...amounts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median < FANOUT_MIN_MEDIAN) return null;
  }

  return {
    members: bestMembers.sort(),
    windowStart: bestWindowStart,
    windowEnd: bestWindowEnd,
    uniqueCount: bestCount,
    totalAmount: bestTotalAmount,
    meanAmountPerReceiver: Number(meanAmount.toFixed(2)),
  };
};

const runSmurfingDetection = (graphContext) => {
  const { temporalIndex, velocityMetrics, outgoingEdges, incomingEdges } = graphContext;

  // Guard: temporalIndex must be a Map of accountId -> txns[]
  // (the main 'index' from buildTemporalIndex, not the wrapper { index, inIndex, outIndex }).
  if (!temporalIndex || !(temporalIndex instanceof Map)) {
    throw new Error(
      '[smurfing] temporalIndex must be a Map (the main index from buildTemporalIndex), ' +
      'not the wrapper object. Pass graphContext.temporalIndex = result.index instead. ' +
      `Received: ${temporalIndex === null ? 'null' : typeof temporalIndex}`
    );
  }

  // Guard: velocityMetrics must be a Map
  if (!velocityMetrics || !(velocityMetrics instanceof Map)) {
    throw new Error(
      '[smurfing] velocityMetrics must be a Map. ' +
      `Received: ${velocityMetrics === null ? 'null' : typeof velocityMetrics}`
    );
  }

  const fanInAccounts = new Set();
  const fanOutAccounts = new Set();

  const fanInDetails = [];
  const fanOutDetails = [];

  const accountIds = [...temporalIndex.keys()].sort();

  for (const accountId of accountIds) {
    if (isLowVelocityAccount(accountId, velocityMetrics)) continue;

    const txns = temporalIndex.get(accountId);
    if (!txns || txns.length === 0) continue;

    const fanInTxns = txns.filter((t) => t.receiver_id === accountId);
    const fanOutTxns = txns.filter((t) => t.sender_id === accountId);

    if (fanInTxns.length >= SMURFING_THRESHOLD) {
      const fanInResult = detectFanIn(accountId, fanInTxns);
      if (fanInResult && !isLikelyMerchant(accountId, velocityMetrics, incomingEdges, outgoingEdges)) {
        fanInAccounts.add(accountId);
        fanInDetails.push({
          account_id: accountId,
          pattern: 'fan_in',
          members: [accountId, ...fanInResult.members],
          window_start: fanInResult.windowStart,
          window_end: fanInResult.windowEnd,
          unique_sender_count: fanInResult.uniqueCount,
          total_amount: fanInResult.totalAmount,
          mean_amount_per_sender: fanInResult.meanAmountPerSender,
        });
      }
    }

    if (fanOutTxns.length >= SMURFING_THRESHOLD) {
      const fanOutResult = detectFanOut(accountId, fanOutTxns);
      if (fanOutResult && !isLikelyPayroll(accountId, velocityMetrics, outgoingEdges)) {
        fanOutAccounts.add(accountId);
        fanOutDetails.push({
          account_id: accountId,
          pattern: 'fan_out',
          members: [accountId, ...fanOutResult.members],
          window_start: fanOutResult.windowStart,
          window_end: fanOutResult.windowEnd,
          unique_receiver_count: fanOutResult.uniqueCount,
          total_amount: fanOutResult.totalAmount,
          mean_amount_per_receiver: fanOutResult.meanAmountPerReceiver,
        });
      }
    }
  }

  const smurfingResults = {
    fanInAccounts,
    fanOutAccounts,
    fanInDetails,
    fanOutDetails,
  };

  graphContext.smurfingResults = smurfingResults;

  return smurfingResults;
};

module.exports = { runSmurfingDetection };
