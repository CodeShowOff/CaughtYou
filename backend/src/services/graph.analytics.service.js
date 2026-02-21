const {
  BATCH_MODE_SAME_TS_RATIO,
  BATCH_MODE_STDDEV_MS,
} = require('../config/constants');

const buildDegreeMap = (outgoingEdges, incomingEdges) => {
  const degreeMap = new Map();

  for (const id of outgoingEdges.keys()) {
    degreeMap.set(id, {
      inDegree: 0, outDegree: 0, totalDegree: 0,
      uniqueInDegree: 0, uniqueOutDegree: 0, uniqueTotalDegree: 0,
    });
  }
  for (const id of incomingEdges.keys()) {
    if (!degreeMap.has(id)) {
      degreeMap.set(id, {
        inDegree: 0, outDegree: 0, totalDegree: 0,
        uniqueInDegree: 0, uniqueOutDegree: 0, uniqueTotalDegree: 0,
      });
    }
  }

  for (const [id, edges] of outgoingEdges) {
    const d = degreeMap.get(id);
    // Exclude self-loops from degree counts
    const nonSelfEdges = edges.filter((e) => e.to !== id);
    d.outDegree = nonSelfEdges.length;
    const uniqueTargets = new Set(nonSelfEdges.map((e) => e.to));
    d.uniqueOutDegree = uniqueTargets.size;
  }

  for (const [id, edges] of incomingEdges) {
    const d = degreeMap.get(id);
    // Exclude self-loops from degree counts
    const nonSelfEdges = edges.filter((e) => e.from !== id);
    d.inDegree = nonSelfEdges.length;
    const uniqueSources = new Set(nonSelfEdges.map((e) => e.from));
    d.uniqueInDegree = uniqueSources.size;
  }

  for (const data of degreeMap.values()) {
    data.totalDegree = data.inDegree + data.outDegree;
    data.uniqueTotalDegree = data.uniqueInDegree + data.uniqueOutDegree;
  }

  return degreeMap;
};

/**
 * Detect whether the dataset looks like a batch import (all/most timestamps identical).
 * Returns true if velocity scoring should be suppressed.
 *
 * NOTE: Uses absolute timestamp frequency and stddev. If timestamps have
 * microsecond-level variation from ingestion pipelines or timezone shifts,
 * this may misclassify — tune BATCH_MODE_SAME_TS_RATIO and BATCH_MODE_STDDEV_MS
 * via environment variables for your dataset characteristics.
 */
const isBatchMode = (temporalIndex) => {
  // Collect all timestamps across all accounts
  const allTs = [];
  for (const txns of temporalIndex.values()) {
    for (const tx of txns) {
      if (tx.timestamp) allTs.push(tx.timestamp.getTime());
    }
  }
  if (allTs.length < 2) return false;

  // Check 1: if >= BATCH_MODE_SAME_TS_RATIO share the same timestamp
  const tsFreq = new Map();
  for (const ts of allTs) {
    tsFreq.set(ts, (tsFreq.get(ts) || 0) + 1);
  }
  const maxFreq = Math.max(...tsFreq.values());
  if (maxFreq / allTs.length >= BATCH_MODE_SAME_TS_RATIO) return true;

  // Check 2: stddev of timestamps is very small
  const mean = allTs.reduce((s, t) => s + t, 0) / allTs.length;
  const variance = allTs.reduce((s, t) => s + (t - mean) ** 2, 0) / allTs.length;
  const stddev = Math.sqrt(variance);
  if (stddev < BATCH_MODE_STDDEV_MS) return true;

  return false;
};

const computeVelocityMetrics = (temporalIndex) => {
  const velocityMap = new Map();

  // Detect batch-loaded data: if timestamps are near-identical, suppress velocity signals
  const batchMode = isBatchMode(temporalIndex);

  for (const [accountId, txns] of temporalIndex) {
    // Exclude self-transfers from velocity calculation
    const nonSelfTxns = txns.filter((t) => t.sender_id !== t.receiver_id);

    if (nonSelfTxns.length === 0) {
      velocityMap.set(accountId, {
        total_transactions: 0,
        first_timestamp: null,
        last_timestamp: null,
        active_duration_hours: 0,
        batch_mode: batchMode,
      });
      continue;
    }

    const first = nonSelfTxns[0].timestamp;
    const last = nonSelfTxns[nonSelfTxns.length - 1].timestamp;
    const durationMs = last.getTime() - first.getTime();
    // Allow zero for instantaneous bursts (multiple txns at exact same instant).
    // Floor non-zero durations to 1 second (1/3600 hours) to avoid division
    // artefacts. NOTE: this means 1-second bursts with multiple txns may be
    // treated similarly to truly instantaneous ones by downstream isHighVelocity
    // (which uses EPSILON_HOURS = 1/3600). This is acceptable: both indicate
    // unusually rapid activity.
    let durationHours;
    if (durationMs === 0) {
      durationHours = 0; // signal instantaneous burst
    } else {
      durationHours = Math.max(durationMs / (1000 * 60 * 60), 1 / 3600);
    }

    // In batch mode, artificially inflate duration to prevent false velocity spikes.
    // WARNING: This is a blunt suppression — if batchMode detection is noisy,
    // legitimate high-velocity accounts will lose their velocity signal.
    // Consider tuning BATCH_MODE_SAME_TS_RATIO / BATCH_MODE_STDDEV_MS if
    // you observe false negatives in velocity detection.
    if (batchMode) {
      durationHours = Math.max(durationHours, 720); // treat as 30 days minimum
    }

    velocityMap.set(accountId, {
      total_transactions: nonSelfTxns.length,
      first_timestamp: first,
      last_timestamp: last,
      active_duration_hours: Math.round(durationHours * 10000) / 10000,
      batch_mode: batchMode,
    });
  }

  return velocityMap;
};

module.exports = { buildDegreeMap, computeVelocityMetrics };
