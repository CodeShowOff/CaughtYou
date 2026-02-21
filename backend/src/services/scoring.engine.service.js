const crypto = require('crypto');
const { scoring: scoringCfg } = require('../config/detectors');

const {
  SCORE_CYCLE,
  SCORE_FAN_IN,
  SCORE_FAN_OUT,
  SCORE_SHELL,
  SCORE_VELOCITY,
  SCORE_AMOUNT,
  MIN_SUSPICION_THRESHOLD,
  HIGH_VELOCITY_TX_MIN,
  HIGH_VELOCITY_DURATION_MAX_H,
} = scoringCfg;

// --- Reason code constants for machine-readable triage ---
const REASON = {
  CYCLE: (len) => `CYCLE:LEN=${len}`,
  FAN_IN: (count) => `FAN_IN:SENDERS=${count}`,
  FAN_OUT: (count) => `FAN_OUT:RECEIVERS=${count}`,
  MULE: (len) => `MULE:CHAIN_LEN=${len}`,
  VELOCITY: (txns, hours) => `VELOCITY:${txns}TX/${hours}H`,
  AMOUNT: (pct) => `AMOUNT:P${pct}`,
};

const getOrCreate = (scoreMap, accountId) => {
  if (!scoreMap.has(accountId)) {
    scoreMap.set(accountId, {
      account_id: accountId,
      raw_score: 0,
      sub_scores: {
        cycle: 0,
        fan_in: 0,
        fan_out: 0,
        mule: 0,
        velocity: 0,
        amount: 0,
      },
      confidence: 'low',        // low | medium | high
      detector_count: 0,
      detected_patterns: new Set(),
      ring_ids: new Set(),
      reason_codes: [],
      supporting_transactions: [],
      key_metrics: {
        sum_incoming: 0,
        sum_outgoing: 0,
        unique_counterparties_in: 0,
        unique_counterparties_out: 0,
        transaction_count: 0,
        peak_velocity_tx_per_hour: 0,
      },
    });
  }
  return scoreMap.get(accountId);
};

const normaliseScore = (score) => {
  const clamped = Math.min(100, Math.max(0, score));
  return Number(clamped.toFixed(1));
};

const isHighVelocity = (accountId, velocityMetrics) => {
  const v = velocityMetrics.get(accountId);
  if (!v) return false;
  // Treat zero/near-zero duration as high velocity only if there are enough
  // transactions (avoids flagging accounts with just 1 tx at duration=0).
  // Uses <= epsilon (1 second = 1/3600 h) to catch both exact-zero and the
  // legacy 1-second floor from computeVelocityMetrics.
  const EPSILON_HOURS = 1 / 3600;
  if (v.active_duration_hours <= EPSILON_HOURS) {
    return v.total_transactions >= HIGH_VELOCITY_TX_MIN;
  }
  return (
    v.total_transactions >= HIGH_VELOCITY_TX_MIN &&
    v.active_duration_hours <= HIGH_VELOCITY_DURATION_MAX_H
  );
};

/**
 * Compute a [0,1] amount score for an account by comparing its total
 * transaction volume to the 90th-percentile across all accounts.
 */
const computeAmountScore = (accountId, nodes, globalStats) => {
  const node = nodes.get(accountId);
  if (!node) return 0;
  const total = node.total_incoming + node.total_outgoing;
  const p90 = globalStats.amountP90 || 1;
  return Math.min(1, total / p90);
};

/**
 * Compute global stats used for amount normalisation.
 * Uses only numeric, finite totals to avoid NaN propagation.
 */
const computeGlobalStats = (nodes) => {
  const totals = [];
  for (const n of nodes.values()) {
    // Use Decimal sums converted to Number for accuracy, falling back to plain sums
    let total;
    if (n.sum_incoming_decimal && n.sum_outgoing_decimal) {
      total = Number(n.sum_incoming_decimal.plus(n.sum_outgoing_decimal).toFixed(2));
    } else {
      total = n.total_incoming + n.total_outgoing;
    }
    if (Number.isFinite(total)) {
      totals.push(total);
    }
  }
  totals.sort((a, b) => a - b);
  // Use Math.ceil for p90 to get the correct percentile index
  // (for small arrays, Math.floor can select too low an index)
  const p90Idx = totals.length > 0 ? Math.min(Math.ceil(totals.length * 0.9) - 1, totals.length - 1) : 0;
  return {
    amountP90: totals[p90Idx] || 1,
    amountMedian: totals[Math.floor(totals.length * 0.5)] || 0,
  };
};

/**
 * Collect per-account key metrics for triage payloads.
 * Returns a consistent shape that includes all fields from getOrCreate defaults.
 */
const buildKeyMetrics = (accountId, nodes, incomingEdges, outgoingEdges, velocityMetrics) => {
  const node = nodes.get(accountId);
  const inEdges = incomingEdges.get(accountId) || [];
  const outEdges = outgoingEdges.get(accountId) || [];

  // Compute peak velocity (tx per hour) — use safe floor to avoid Infinity
  let peakVelocity = 0;
  const v = velocityMetrics ? velocityMetrics.get(accountId) : null;
  if (v && v.total_transactions > 0) {
    const durationH = Math.max(v.active_duration_hours, 0.001);
    peakVelocity = Number((v.total_transactions / durationH).toFixed(2));
  }

  return {
    sum_incoming: node ? node.total_incoming : 0,
    sum_outgoing: node ? node.total_outgoing : 0,
    unique_counterparties_in: new Set(inEdges.map(e => e.from)).size,
    unique_counterparties_out: new Set(outEdges.map(e => e.to)).size,
    transaction_count: node ? node.transaction_count : 0,
    peak_velocity_tx_per_hour: peakVelocity,
  };
};

const computeRingRiskScore = (members, scoreMap) => {
  let maxScore = 0;
  for (const acc of members) {
    const entry = scoreMap.get(acc);
    if (entry && entry.raw_score > 0) {
      const score = normaliseScore(entry.raw_score);
      if (score > maxScore) maxScore = score;
    }
  }
  return maxScore;
};

/** Stable ring ID from sorted member list */
const stableRingId = (members, patternType) => {
  const canonical = [...members].sort().join('>') + '|' + patternType;
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `RING_${hash.toUpperCase()}`;
};

/**
 * Remove transient internal properties (prefixed with _) from score entries
 * before they are exported or returned to callers.
 * Also ensures no Decimal objects remain in exported data.
 *
 * NOTE: After sanitization, Sets become arrays and Maps become objects.
 * Code running after sanitizeEntry must NOT call .has() on detected_patterns
 * or .size on ring_ids — use Array methods instead.
 */
const sanitizeEntry = (entry) => {
  // Lazy-load Decimal to avoid circular dependency issues
  const Decimal = require('decimal.js');

  for (const key of Object.keys(entry)) {
    if (key.startsWith('_')) {
      delete entry[key];
      continue;
    }
    const val = entry[key];
    // Convert Set to sorted array for JSON serialization
    if (val instanceof Set) {
      entry[key] = [...val].sort();
      continue;
    }
    // Convert Map to plain object for JSON serialization
    if (val instanceof Map) {
      const obj = {};
      for (const [k, v] of val) obj[String(k)] = v;
      entry[key] = obj;
      continue;
    }
    // Convert Decimal objects to plain numbers (use instanceof for safety)
    if (val instanceof Decimal) {
      entry[key] = val.toNumber();
    } else if (val && typeof val === 'object' && typeof val.toNumber === 'function' && !(val instanceof Date)) {
      // Fallback for Decimal-like objects from different module instances
      entry[key] = val.toNumber();
    }
  }
  // Also sanitize key_metrics
  if (entry.key_metrics && typeof entry.key_metrics === 'object') {
    for (const [k, v] of Object.entries(entry.key_metrics)) {
      if (v instanceof Decimal) {
        entry.key_metrics[k] = v.toNumber();
      } else if (v && typeof v === 'object' && typeof v.toNumber === 'function') {
        entry.key_metrics[k] = v.toNumber();
      }
    }
  }
};

const runScoringEngine = (graphContext) => {
  const {
    fraudRings = [],
    smurfingResults = { fanInAccounts: new Set(), fanOutAccounts: new Set(), fanInDetails: [], fanOutDetails: [] },
    shellResults,
    velocityMetrics,
    nodes,
    incomingEdges,
    outgoingEdges,
  } = graphContext;

  const scoreMap = new Map();
  const globalStats = computeGlobalStats(nodes);

  // --- 1. Cycle scoring ---
  for (const ring of fraudRings) {
    const patternLabel = `cycle_length_${ring.member_accounts.length}`;
    for (const acc of ring.member_accounts) {
      const entry = getOrCreate(scoreMap, acc);
      if (!entry._cycleScored) {
        entry.raw_score += SCORE_CYCLE;
        entry.sub_scores.cycle = SCORE_CYCLE;
        entry._cycleScored = true;
        entry.reason_codes.push(REASON.CYCLE(ring.member_accounts.length));
      }
      entry.detected_patterns.add(patternLabel);
      entry.ring_ids.add(ring.ring_id);
    }
  }

  // --- 2. Fan-in / fan-out scoring ---
  const { fanInAccounts = new Set(), fanOutAccounts = new Set() } = smurfingResults;
  const fanInDetailMap = new Map();
  for (const d of (smurfingResults.fanInDetails || [])) {
    fanInDetailMap.set(d.account_id, d);
  }
  const fanOutDetailMap = new Map();
  for (const d of (smurfingResults.fanOutDetails || [])) {
    fanOutDetailMap.set(d.account_id, d);
  }

  for (const acc of fanInAccounts) {
    const entry = getOrCreate(scoreMap, acc);
    entry.raw_score += SCORE_FAN_IN;
    entry.sub_scores.fan_in = SCORE_FAN_IN;
    entry.detected_patterns.add('fan_in');
    const detail = fanInDetailMap.get(acc);
    const count = detail ? detail.unique_sender_count : '?';
    entry.reason_codes.push(REASON.FAN_IN(count));
  }

  for (const acc of fanOutAccounts) {
    const entry = getOrCreate(scoreMap, acc);
    entry.raw_score += SCORE_FAN_OUT;
    entry.sub_scores.fan_out = SCORE_FAN_OUT;
    entry.detected_patterns.add('fan_out');
    const detail = fanOutDetailMap.get(acc);
    const count = detail ? detail.unique_receiver_count : '?';
    entry.reason_codes.push(REASON.FAN_OUT(count));
  }

  // --- 3. Mule chain scoring ---
  const shellChains = shellResults ? shellResults.shellChains : [];

  for (const chain of shellChains) {
    for (const acc of chain.path) {
      const entry = getOrCreate(scoreMap, acc);
      if (!entry.detected_patterns.has('mule_chain')) {
        entry.raw_score += SCORE_SHELL;
        entry.sub_scores.mule = SCORE_SHELL;
        entry.detected_patterns.add('mule_chain');
        entry.reason_codes.push(REASON.MULE(chain.path.length));
      }
    }
  }

  // --- 4. Velocity scoring — for ALL accounts, not just already-flagged ones ---
  const sortedNodeIds = [...nodes.keys()].sort();

  for (const acc of sortedNodeIds) {
    if (isHighVelocity(acc, velocityMetrics)) {
      const entry = getOrCreate(scoreMap, acc);
      entry.raw_score += SCORE_VELOCITY;
      entry.sub_scores.velocity = SCORE_VELOCITY;
      entry.detected_patterns.add('high_velocity');
      const v = velocityMetrics.get(acc);
      entry.reason_codes.push(
        REASON.VELOCITY(v.total_transactions, v.active_duration_hours.toFixed(1))
      );
    }
  }

  // --- 5. Amount-aware scoring — for ALL accounts, not just already-flagged ones ---
  for (const acc of sortedNodeIds) {
    const amountScore = computeAmountScore(acc, nodes, globalStats);
    if (amountScore > 0.5) {
      const entry = getOrCreate(scoreMap, acc);
      const amountPoints = SCORE_AMOUNT * amountScore;
      entry.raw_score += amountPoints;
      entry.sub_scores.amount = Number(amountPoints.toFixed(1));
      entry.detected_patterns.add('high_amount');
      entry.reason_codes.push(REASON.AMOUNT((amountScore * 100).toFixed(0)));
    }
  }

  // --- 5b. Compute confidence levels and detector counts ---
  for (const entry of scoreMap.values()) {
    // Count distinct detectors that fired.
    // Pattern matching uses explicit checks for each detector type to avoid
    // brittle startsWith/replace heuristics.
    const hasCycle = [...entry.detected_patterns].some((p) => p.startsWith('cycle_length_'));
    const hasShell = entry.detected_patterns.has('mule_chain');
    const hasFanIn = entry.detected_patterns.has('fan_in');
    const hasFanOut = entry.detected_patterns.has('fan_out');
    const hasVelocity = entry.detected_patterns.has('high_velocity');
    const hasAmount = entry.detected_patterns.has('high_amount');

    const structuralCount = (hasCycle ? 1 : 0) + (hasShell ? 1 : 0) + (hasFanIn ? 1 : 0) + (hasFanOut ? 1 : 0);

    // detector_count includes ALL detectors (structural + behavioral)
    entry.detector_count = structuralCount + (hasVelocity ? 1 : 0) + (hasAmount ? 1 : 0);

    // Confidence rules:
    // high: one strong structural detector (cycle/shell) OR two+ structural detectors
    // medium: one structural detector (includes when combined with behavioral)
    // low:  behavioral only (velocity/amount)
    if (hasCycle || hasShell || (structuralCount >= 2)) {
      entry.confidence = 'high';
    } else if (structuralCount >= 1) {
      entry.confidence = 'medium';
    } else {
      entry.confidence = 'low';
    }
  }

  // --- 6. Build key metrics for every scored account ---
  for (const [acc, entry] of scoreMap) {
    entry.key_metrics = buildKeyMetrics(
      acc, nodes,
      incomingEdges || new Map(),
      outgoingEdges || new Map(),
      velocityMetrics,
    );
  }

  // --- 7. Build unified fraud rings with stable IDs ---
  // Build ring registry FIRST, then assign ring_ids to score entries
  // This prevents duplicate scoring issues from separate iterations.
  const enrichedCycleRings = fraudRings.map((ring) => ({
    ring_id: ring.ring_id,
    member_accounts: ring.member_accounts,
    pattern_type: ring.pattern_type,
    risk_score: computeRingRiskScore(ring.member_accounts, scoreMap),
  }));

  const sortedFanInDetails = [...(smurfingResults.fanInDetails || [])].sort(
    (a, b) => a.account_id.localeCompare(b.account_id)
  );

  const fanInRings = sortedFanInDetails.map((detail) => ({
    ring_id: stableRingId(detail.members, 'fan_in'),
    member_accounts: detail.members,
    pattern_type: 'fan_in',
    risk_score: computeRingRiskScore(detail.members, scoreMap),
  }));

  const sortedFanOutDetails = [...(smurfingResults.fanOutDetails || [])].sort(
    (a, b) => a.account_id.localeCompare(b.account_id)
  );

  const fanOutRings = sortedFanOutDetails.map((detail) => ({
    ring_id: stableRingId(detail.members, 'fan_out'),
    member_accounts: detail.members,
    pattern_type: 'fan_out',
    risk_score: computeRingRiskScore(detail.members, scoreMap),
  }));

  const sortedShellChains = [...shellChains].sort((a, b) =>
    a.path.join('>').localeCompare(b.path.join('>'))
  );

  const shellRings = sortedShellChains.map((chain) => ({
    ring_id: chain.chain_id,
    member_accounts: chain.path,
    pattern_type: 'mule_chain',
    risk_score: computeRingRiskScore(chain.path, scoreMap),
  }));

  // Single pass: assign ring_ids to score entries (avoids duplicating across multiple loops)
  const allRings = [...enrichedCycleRings, ...fanInRings, ...fanOutRings, ...shellRings];

  for (const ring of allRings) {
    for (const acc of ring.member_accounts) {
      if (scoreMap.has(acc)) {
        scoreMap.get(acc).ring_ids.add(ring.ring_id);
      }
    }
  }

  const ringRiskLookup = new Map();
  for (const ring of allRings) {
    ringRiskLookup.set(ring.ring_id, ring.risk_score || 0);
  }

  // --- Memory pruning: remove entries with negligible scores ---
  // Entries that scored below a small fraction of the threshold are noise.
  // IMPORTANT: Only prune entries that have no ring associations AND are
  // not referenced as members in any ring. Pruning ring members would
  // cause missing accounts in downstream exports.
  const pruneThreshold = MIN_SUSPICION_THRESHOLD * 0.25;
  const allRingMembers = new Set();
  for (const ring of allRings) {
    for (const acc of ring.member_accounts) {
      allRingMembers.add(acc);
    }
  }
  for (const [acc, entry] of scoreMap) {
    if (entry.raw_score < pruneThreshold && entry.ring_ids.size === 0 && !allRingMembers.has(acc)) {
      scoreMap.delete(acc);
    }
  }

  // --- 7b. Sanitize internal flags and convert Sets/Maps after all mutations ---
  for (const entry of scoreMap.values()) {
    sanitizeEntry(entry);
  }

  const suspiciousAccounts = [];

  for (const [, entry] of scoreMap) {
    if (entry.raw_score < MIN_SUSPICION_THRESHOLD) continue;

    const score = normaliseScore(entry.raw_score);
    const patterns = [...entry.detected_patterns].sort();
    const ringIds = [...entry.ring_ids].sort();

    let bestRingId = 'UNASSIGNED';
    if (ringIds.length > 0) {
      bestRingId = ringIds[0];
      let bestRisk = ringRiskLookup.get(bestRingId) || 0;
      for (let i = 1; i < ringIds.length; i++) {
        const candidateRisk = ringRiskLookup.get(ringIds[i]) || 0;
        if (candidateRisk > bestRisk || (candidateRisk === bestRisk && ringIds[i] < bestRingId)) {
          bestRingId = ringIds[i];
          bestRisk = candidateRisk;
        }
      }
    }

    suspiciousAccounts.push({
      account_id: entry.account_id,
      suspicion_score: score,
      confidence: entry.confidence,
      detector_count: entry.detector_count,
      sub_scores: entry.sub_scores,
      detected_patterns: patterns,
      ring_id: bestRingId,
      reason_codes: entry.reason_codes,
      key_metrics: entry.key_metrics,
    });
  }

  suspiciousAccounts.sort((a, b) => {
    if (b.suspicion_score !== a.suspicion_score) {
      return b.suspicion_score - a.suspicion_score;
    }
    return a.account_id.localeCompare(b.account_id);
  });

  const unifiedFraudRings = [
    ...enrichedCycleRings,
    ...fanInRings,
    ...fanOutRings,
    ...shellRings,
  ];

  graphContext.suspiciousAccounts = suspiciousAccounts;
  graphContext.unifiedFraudRings = unifiedFraudRings;

  return { suspiciousAccounts, unifiedFraudRings };
};

module.exports = { runScoringEngine };
