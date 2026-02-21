const Decimal = require('decimal.js');
const crypto = require('crypto');
const {
  MAX_REASONABLE_AMOUNT,
  TIMESTAMP_MAX_AGE_YEARS,
  TIMESTAMP_MAX_FUTURE_DAYS,
} = require('../config/constants');

/**
 * Parse a value to a Decimal safely. Returns a Decimal instance
 * whether the input is already a Decimal, a number, or a numeric string.
 */
const toDecimal = (v) => {
  if (v instanceof Decimal) return v;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

/**
 * Hash an account ID for safe logging (PII protection).
 * Returns first 8 chars of SHA-256 hash.
 */
const maskId = (id) => {
  if (!id) return '<empty>';
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8);
};

/**
 * Ensure timestamp is a Date object. If it's already a Date, return it;
 * otherwise parse from string. Throws if the result is invalid.
 */
const ensureDate = (t) => {
  if (t instanceof Date) {
    if (Number.isNaN(t.getTime())) throw new Error(`Invalid Date object`);
    return t;
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`Cannot parse timestamp: ${t}`);
  return d;
};

const buildGraph = (transactions) => {
  const nodes = new Map();
  const outgoingEdges = new Map();
  const incomingEdges = new Map();

  const ensureNode = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        account_id: id,
        total_incoming: 0,
        total_outgoing: 0,
        sum_incoming_decimal: new Decimal(0),
        sum_outgoing_decimal: new Decimal(0),
        transaction_count: 0,
        transaction_count_in: 0,
        transaction_count_out: 0,
      });
      outgoingEdges.set(id, []);
      incomingEdges.set(id, []);
    }
  };

  // Track duplicates by transaction_id (with fallback composite key)
  const seenTxIds = new Set();
  let missingIdCount = 0;
  let skippedCount = 0;

  // Build a canonical deduped transaction list to return
  const dedupedTransactions = [];

  for (const tx of transactions) {
    // Validate sender/receiver IDs are non-empty
    const senderId = tx.sender_id != null ? String(tx.sender_id).trim() : '';
    const receiverId = tx.receiver_id != null ? String(tx.receiver_id).trim() : '';
    if (!senderId || !receiverId) {
      console.warn(`[graph.service] Skipping tx with missing sender/receiver: sender="${maskId(senderId)}", receiver="${maskId(receiverId)}"`);
      skippedCount++;
      continue;
    }

    // Coerce and validate amount to a number before any arithmetic
    let amountNum;
    if (typeof tx.amount === 'number') {
      amountNum = tx.amount;
    } else {
      // Clean common currency formatting (commas, spaces, currency symbols)
      const rawStr = String(tx.amount).trim();
      let cleaned;

      // Detect European format: dots as thousands separators, comma as decimal
      // e.g. "1.234,56" or "1.234.567,89"
      const europeanPattern = /^[^,]*\.[^,]*,\d{1,2}$/;

      if (europeanPattern.test(rawStr.replace(/[^0-9.,]/g, ''))) {
        // European format: remove dots (thousands), replace comma with dot (decimal)
        cleaned = rawStr.replace(/[^0-9.,\-eE+]/g, '').replace(/\./g, '').replace(',', '.');
      } else if (rawStr.includes(',') && !rawStr.includes('.')) {
        // Locale uses comma as decimal separator (e.g. "1234,56" or "1 234,56")
        cleaned = rawStr.replace(/[^0-9,\-eE+]/g, '').replace(',', '.');
      } else if (rawStr.includes(',') && rawStr.includes('.')) {
        // US-style thousands separator (e.g. "1,234.56")
        cleaned = rawStr.replace(/,/g, '').replace(/[^0-9.\-eE+]/g, '');
      } else {
        cleaned = rawStr.replace(/[^0-9.\-eE+]/g, '');
      }
      amountNum = Number(cleaned);
    }
    if (!Number.isFinite(amountNum)) {
      console.warn(`[graph.service] Invalid amount for tx ${maskId(tx.transaction_id || 'unknown')}, skipping`);
      skippedCount++;
      continue;
    }
    // Skip zero or negative amounts (refunds/reversals should be handled separately)
    if (amountNum <= 0) {
      console.warn(`[graph.service] Non-positive amount for tx ${maskId(tx.transaction_id || 'unknown')}, skipping`);
      skippedCount++;
      continue;
    }

    // Guard: reject extreme amounts that could distort analytics
    if (amountNum > MAX_REASONABLE_AMOUNT) {
      console.warn(`[graph.service] Amount exceeds MAX_REASONABLE_AMOUNT (${MAX_REASONABLE_AMOUNT}) for tx ${maskId(tx.transaction_id || 'unknown')}, skipping`);
      skippedCount++;
      continue;
    }

    // Safe timestamp parsing
    let timestamp;
    try {
      timestamp = ensureDate(tx.timestamp);
    } catch (e) {
      console.warn(`[graph.service] Invalid timestamp for tx ${tx.transaction_id || 'unknown'}: "${tx.timestamp}", skipping`);
      skippedCount++;
      continue;
    }

    // Timestamp validation: reject timestamps outside reasonable window
    const now = Date.now();
    const minTs = now - TIMESTAMP_MAX_AGE_YEARS * 365.25 * 24 * 60 * 60 * 1000;
    const maxTs = now + TIMESTAMP_MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000;
    if (timestamp.getTime() < minTs || timestamp.getTime() > maxTs) {
      console.warn(`[graph.service] Timestamp outside valid range for tx ${maskId(tx.transaction_id || 'unknown')}: "${timestamp.toISOString()}", skipping`);
      skippedCount++;
      continue;
    }

    // Build a stable dedup key: use transaction_id if present, else composite key.
    // Use timestamp ms (integer) instead of amountNum (float) in composite key
    // to avoid floating-point stringify instability.
    const hasValidId = tx.transaction_id != null && String(tx.transaction_id).trim() !== '';
    const txKey = hasValidId
      ? String(tx.transaction_id)
      : `${senderId}|${receiverId}|${timestamp.getTime()}|${amountNum.toFixed(4)}|${tx.currency || 'USD'}`;

    if (!hasValidId) missingIdCount++;

    if (seenTxIds.has(txKey)) {
      // Note: duplicates with missing IDs were already counted above;
      // this is intentional — missingIdCount reflects total txns without IDs,
      // not just unique ones.
      continue;
    }
    seenTxIds.add(txKey);

    // Validate amountDecimal: only use it if it's already a Decimal instance;
    // otherwise fall back to the parsed amountNum to avoid string-format issues.
    const rawDecimal = tx.amountDecimal;
    const amountDec = (rawDecimal instanceof Decimal) ? rawDecimal : toDecimal(amountNum);
    const currency = tx.currency || 'USD';
    const transaction_id = tx.transaction_id || txKey;

    // Push canonical transaction to deduped list
    const canonical = {
      transaction_id,
      sender_id: senderId,
      receiver_id: receiverId,
      amount: amountNum,
      amountDecimal: amountDec,
      currency,
      timestamp,
    };
    dedupedTransactions.push(canonical);

    ensureNode(senderId);
    ensureNode(receiverId);

    outgoingEdges.get(senderId).push({
      to: receiverId,
      amount: amountNum,
      amountDecimal: amountDec,
      currency,
      timestamp,
      transaction_id,
      direction: 'out',
    });

    incomingEdges.get(receiverId).push({
      from: senderId,
      amount: amountNum,
      amountDecimal: amountDec,
      currency,
      timestamp,
      transaction_id,
      direction: 'in',
    });

    const senderNode = nodes.get(senderId);
    senderNode.total_outgoing += amountNum;
    senderNode.sum_outgoing_decimal = senderNode.sum_outgoing_decimal.plus(amountDec);
    senderNode.transaction_count += 1;
    senderNode.transaction_count_out += 1;

    const receiverNode = nodes.get(receiverId);
    receiverNode.total_incoming += amountNum;
    receiverNode.sum_incoming_decimal = receiverNode.sum_incoming_decimal.plus(amountDec);
    receiverNode.transaction_count += 1;
    receiverNode.transaction_count_in += 1;
  }

  if (missingIdCount > 0) {
    console.warn(`[graph.service] ${missingIdCount} transaction(s) missing transaction_id — used composite key for dedup.`);
  }
  if (skippedCount > 0) {
    console.warn(`[graph.service] ${skippedCount} transaction(s) skipped due to invalid data.`);
  }

  // Build adjacency lookup maps for O(1) edge lookup: nodeId -> Map(targetId -> [edges])
  const outgoingMap = new Map();
  for (const [from, edges] of outgoingEdges) {
    const m = new Map();
    for (const e of edges) {
      if (!m.has(e.to)) m.set(e.to, []);
      m.get(e.to).push(e);
    }
    outgoingMap.set(from, m);
  }

  const incomingMap = new Map();
  for (const [to, edges] of incomingEdges) {
    const m = new Map();
    for (const e of edges) {
      if (!m.has(e.from)) m.set(e.from, []);
      m.get(e.from).push(e);
    }
    incomingMap.set(to, m);
  }

  return {
    nodes,
    outgoingEdges,
    incomingEdges,
    outgoingMap,
    incomingMap,
    globalTransactionList: dedupedTransactions,
  };
};

module.exports = { buildGraph };
