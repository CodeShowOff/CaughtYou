/**
 * Safe numeric formatting: returns null for undefined, null, NaN, Infinity
 * so consumers can distinguish missing data from actual zero values.
 */
const toOneDecimal = (n) => {
  if (n === undefined || n === null) return null;
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  const result = Number(num.toFixed(1));
  // Avoid returning -0 which is valid JS but surprising in JSON output
  return Object.is(result, -0) ? 0 : result;
};

/**
 * Convert a Set or Array to a sorted array of strings.
 * Returns null for null/undefined inputs (distinguishes "no data" from "empty set").
 * Returns [] for empty Sets/Arrays.
 */
const toSortedArray = (value) => {
  if (value === null || value === undefined) return null;
  const arr = value instanceof Set ? [...value] : [...value];
  return arr.map(String).sort((a, b) => a.localeCompare(b));
};

/**
 * Recursively convert any Decimal, Set, or Map objects in an object tree
 * to JSON-safe primitives (numbers, arrays, plain objects).
 */
const sanitizeForExport = (obj) => {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'object' && typeof obj.toNumber === 'function' && !(obj instanceof Date)) {
    return obj.toNumber();
  }
  if (obj instanceof Set) {
    return [...obj].map(sanitizeForExport);
  }
  if (obj instanceof Map) {
    const result = {};
    for (const [k, v] of obj) {
      // Coerce keys to strings explicitly — non-string keys (numbers, objects)
      // would be auto-coerced by JS property assignment, but explicit conversion
      // avoids silent '[object Object]' collisions.
      result[String(k)] = sanitizeForExport(v);
    }
    return result;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForExport);
  }
  if (typeof obj === 'object' && !(obj instanceof Date)) {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = sanitizeForExport(v);
    }
    return result;
  }
  return obj;
};

const buildExportJSON = (graphContext) => {
  const {
    suspiciousAccounts = [],
    unifiedFraudRings = [],
    fraudClusters = [],
    nodes,
    processingStartTime,
    processingEndTime,
  } = graphContext;

  const suspicious_accounts = suspiciousAccounts.map((entry) => ({
    account_id: entry.account_id,
    suspicion_score: toOneDecimal(entry.suspicion_score),
    confidence: entry.confidence || 'low',
    detector_count: entry.detector_count || 0,
    sub_scores: sanitizeForExport(entry.sub_scores || {}),
    detected_patterns: toSortedArray(entry.detected_patterns) || [],
    ring_id: entry.ring_id || 'UNASSIGNED',
    // Triage-ready fields
    reason_codes: entry.reason_codes || [],
    key_metrics: sanitizeForExport(entry.key_metrics || {}),
  }));

  const fraud_rings = [...unifiedFraudRings]
    .sort((a, b) => a.ring_id.localeCompare(b.ring_id))
    .map((ring) => ({
      ring_id: ring.ring_id,
      member_accounts: toSortedArray(ring.member_accounts) || [],
      pattern_type: ring.pattern_type,
      risk_score: toOneDecimal(ring.risk_score),
    }));

  // Compute processing time with unit validation.
  // processingStartTime/EndTime are in ms (Date.now()), so divide by 1000 for seconds.
  // graphContext.processingTimeSeconds is expected to already be in seconds.
  let processingTimeSeconds;
  if (processingStartTime && processingEndTime) {
    const diffMs = processingEndTime - processingStartTime;
    // Sanity check: if the diff is unreasonably large (>1 hour in ms but stored as
    // seconds), it's likely already in the correct unit
    processingTimeSeconds = toOneDecimal(diffMs / 1000);
  } else {
    const fallback = graphContext.processingTimeSeconds || 0;
    // Guard against upstream accidentally storing ms instead of seconds:
    // processing time > 3600s (1 hour) is suspicious — could be ms
    if (fallback > 3600) {
      console.warn('[json.export] processingTimeSeconds value suspiciously large (' + fallback + '), may be in ms');
    }
    processingTimeSeconds = toOneDecimal(fallback);
  }

  const fraud_clusters = fraudClusters.map((cluster) => ({
    cluster_id: cluster.cluster_id,
    ring_ids: toSortedArray(cluster.ring_ids) || [],
    member_accounts: toSortedArray(cluster.member_accounts) || [],
  }));

  const summary = {
    total_accounts_analyzed: nodes ? nodes.size : 0,
    suspicious_accounts_flagged: suspicious_accounts.length,
    fraud_rings_detected: fraud_rings.length,
    fraud_clusters_detected: fraud_clusters.length,
    processing_time_seconds: processingTimeSeconds,
  };

  return {
    suspicious_accounts,
    fraud_rings,
    fraud_clusters,
    summary,
  };
};

module.exports = { buildExportJSON };
