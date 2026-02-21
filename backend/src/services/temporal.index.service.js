/**
 * Ensure timestamp is a valid Date object.
 */
const ensureDate = (t) => {
  if (t instanceof Date) {
    if (Number.isNaN(t.getTime())) throw new Error(`Invalid Date object in temporal index`);
    return t;
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`Cannot parse timestamp in temporal index: ${t}`);
  return d;
};

/**
 * Build temporal indexes from a list of canonical transactions.
 *
 * Returns `{ index, inIndex, outIndex }` where each is a Map<string, entry[]>.
 * - `index`: all entries for an account (both in and out)
 * - `inIndex`: only incoming entries
 * - `outIndex`: only outgoing entries
 *
 * IMPORTANT: Callers should set `graphContext.temporalIndex = result.index`
 * (the Map), NOT the wrapper object. Detectors expect temporalIndex to be
 * a Map<accountId, entries[]>.
 *
 * Self-transfers are recorded as a single 'in' entry with `self: true`
 * to avoid double-counting in velocity/fan detection.
 */
const buildTemporalIndex = (transactions) => {
  const index = new Map();
  // Separate in/out indexes for efficient directional lookups
  const inIndex = new Map();
  const outIndex = new Map();

  const ensure = (id) => {
    // Normalize ID to trimmed string for consistent key lookup
    if (!index.has(id)) {
      index.set(id, []);
      inIndex.set(id, []);
      outIndex.set(id, []);
    }
  };

  for (const tx of transactions) {
    const timestamp = ensureDate(tx.timestamp);

    // Coerce amount to number for consistency; guard against NaN
    const rawAmount = typeof tx.amount === 'number' ? tx.amount : Number(tx.amount);
    const amount = Number.isFinite(rawAmount) ? rawAmount : 0;

    // Normalize IDs by trimming whitespace
    const senderId = typeof tx.sender_id === 'string' ? tx.sender_id.trim() : String(tx.sender_id || '').trim();
    const receiverId = typeof tx.receiver_id === 'string' ? tx.receiver_id.trim() : String(tx.receiver_id || '').trim();

    const base = {
      transaction_id: tx.transaction_id,
      sender_id: senderId,
      receiver_id: receiverId,
      amount,
      currency: tx.currency || 'USD',
      timestamp,
    };

    ensure(senderId);
    ensure(receiverId);

    if (senderId !== receiverId) {
      // Normal transfer: record out entry for sender, in entry for receiver
      const outEntry = { ...base, direction: 'out' };
      index.get(senderId).push(outEntry);
      outIndex.get(senderId).push(outEntry);

      const inEntry = { ...base, direction: 'in' };
      index.get(receiverId).push(inEntry);
      inIndex.get(receiverId).push(inEntry);
    } else {
      // Self-transfer: record ONLY a single 'in' entry annotated as self-transfer
      // to avoid double-counting in velocity/fan detection.
      // Do NOT add an 'out' entry (contrary to the previous implementation).
      const inEntry = { ...base, direction: 'in', self: true };
      index.get(receiverId).push(inEntry);
      inIndex.get(receiverId).push(inEntry);
    }
  }

  const sortByTimestamp = (a, b) => a.timestamp.getTime() - b.timestamp.getTime();

  for (const list of index.values()) {
    list.sort(sortByTimestamp);
  }
  for (const list of inIndex.values()) {
    list.sort(sortByTimestamp);
  }
  for (const list of outIndex.values()) {
    list.sort(sortByTimestamp);
  }

  return { index, inIndex, outIndex };
};

module.exports = { buildTemporalIndex };
