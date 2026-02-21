const crypto = require('crypto');
const { cycle: cycleCfg } = require('../config/detectors');
const { pickEdge } = require('../utils/edge.selection.util');

const {
  MAX_CYCLE_LENGTH,
  MAX_CYCLES,
  MIN_CYCLE_LENGTH,
  CYCLE_TIME_WINDOW_HOURS,
  CYCLE_AMOUNT_CV_MAX,
  CYCLE_AMOUNT_MIN,
  CYCLE_FLOW_RATIO_MIN,
} = cycleCfg;

/**
 * Rotate a cycle array so the lexicographically smallest element comes first.
 * All elements are compared as strings via localeCompare for consistency
 * with normaliseCycle (avoids locale-dependent `<` operator differences).
 */
const rotateToMin = (cycle) => {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (String(cycle[i]).localeCompare(String(cycle[minIdx])) < 0) {
      minIdx = i;
    }
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
};

/**
 * Canonical form: choose the lexicographically smaller of forward and
 * reverse rotations so A>B>C and C>B>A produce the same key.
 */
const normaliseCycle = (cycle) => {
  const strCycle = cycle.map(String);
  const fwd = rotateToMin(strCycle);
  const rev = rotateToMin([...strCycle].reverse());
  const a = fwd.join('>');
  const b = rev.join('>');
  return a.localeCompare(b) <= 0 ? fwd : rev;
};

const cycleKey = (normalisedCycle) => normalisedCycle.join('>');

/**
 * Check whether the edges forming a cycle satisfy temporal and amount
 * constraints. Returns true if the cycle passes the filters.
 *
 * IMPORTANT: `cycle` must be in the original traversal order (as found by DFS),
 * NOT the canonicalized/rotated form. This ensures temporal and amount checks
 * correspond to actual edge sequences.
 *
 * @param {string[]} cycle - ordered list of account IDs in the cycle (traversal order)
 * @param {Map} outgoingMap - adjacency map: nodeId -> Map(targetId -> [edges])
 */
const passesCycleFilters = (cycle, outgoingMap) => {
  // Collect candidate edges for each consecutive pair in the cycle.
  // Track which hops have timestamped edges so we can decide on temporal filtering.
  const candidateEdgesPerStep = [];
  let hopsWithTimestamps = 0;
  const fallbackAmounts = []; // amounts from hops without timestamps
  for (let i = 0; i < cycle.length; i++) {
    const from = cycle[i];
    const to = cycle[(i + 1) % cycle.length];
    const targetMap = outgoingMap.get(from);
    const stepEdges = targetMap ? (targetMap.get(to) || []) : [];
    if (stepEdges.length === 0) return false; // missing edge data → reject
    // Pre-sort by timestamp ascending (filter out edges without timestamps)
    const sorted = stepEdges
      .filter((e) => e.timestamp)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (sorted.length === 0) {
      // No timestamped edges for this hop — collect amount from any edge
      // and skip temporal checks for this hop
      const anyEdge = stepEdges.find((e) => e.amount != null);
      if (anyEdge) {
        const n = Number(anyEdge.amount);
        if (Number.isFinite(n)) fallbackAmounts.push(n);
      }
      candidateEdgesPerStep.push(null); // placeholder
    } else {
      hopsWithTimestamps++;
      candidateEdgesPerStep.push(sorted);
    }
  }

  // If no hop has timestamps at all, reject (temporal checks impossible)
  if (hopsWithTimestamps === 0) return false;

  // Greedy time-coherent edge picker: try each candidate of the FIRST timestamped
  // step as a starting point, then greedily pick the earliest edge >= prevTs for
  // subsequent steps. Track the combination that yields the smallest time span.
  // Hops without timestamps (null entries in candidateEdgesPerStep) are skipped
  // in temporal selection but their amounts are already collected in fallbackAmounts.
  let bestEdges = null;
  let bestSpan = Infinity;

  // Find the first step with timestamps to seed the greedy picker
  const firstStepIdx = candidateEdgesPerStep.findIndex((s) => s !== null);
  if (firstStepIdx === -1) return false;

  const firstStepCandidates = candidateEdgesPerStep[firstStepIdx];
  for (const startEdge of firstStepCandidates) {
    const selected = [startEdge];
    let prevTs = startEdge.timestamp.getTime();
    let valid = true;

    // Iterate in circular traversal order starting from the step AFTER firstStepIdx,
    // wrapping around so that temporal prevTs propagation follows actual cycle order.
    const totalSteps = candidateEdgesPerStep.length;
    for (let offset = 1; offset < totalSteps; offset++) {
      const step = (firstStepIdx + offset) % totalSteps;
      const sorted = candidateEdgesPerStep[step];
      if (sorted === null) continue; // hop without timestamps, skip
      // Use unified edge-selection policy: earliest edge >= prevTs, else earliest overall
      const chosen = pickEdge(sorted, prevTs);
      if (!chosen) {
        valid = false;
        break;
      }
      prevTs = chosen.timestamp.getTime();
      selected.push(chosen);
    }

    if (!valid) continue;

    const timestamps = selected.map((e) => e.timestamp.getTime());
    const span = Math.max(...timestamps) - Math.min(...timestamps);
    if (span < bestSpan) {
      bestSpan = span;
      bestEdges = selected;
    }
    // If we found a perfectly monotonic tight span, no need to try more starts
    if (bestSpan === 0) break;
  }

  if (!bestEdges) return false;

  const edgeTimestamps = bestEdges.map((e) => e.timestamp.getTime());
  // Collect amounts from selected edges AND fallback amounts from non-timestamped hops.
  // Only include amounts that are valid finite numbers.
  const edgeAmounts = [
    ...bestEdges
      .filter((e) => e.amount != null)
      .map((e) => {
        const n = Number(e.amount);
        return Number.isFinite(n) ? n : null;
      })
      .filter((n) => n !== null),
    ...fallbackAmounts,
  ];

  // --- Temporal constraint ---
  if (CYCLE_TIME_WINDOW_HOURS > 0 && edgeTimestamps.length >= 2) {
    const spanHours = bestSpan / (1000 * 60 * 60);
    if (spanHours > CYCLE_TIME_WINDOW_HOURS) return false;
  }

  // --- Directional time ordering: enforce circularly monotonic timestamps ---
  // Count backward jumps circularly (including wrap from last→first);
  // allow at most 1 for the unavoidable circular wrap.
  if (edgeTimestamps.length >= 2) {
    let backwardJumps = 0;
    const n = edgeTimestamps.length;
    for (let i = 0; i < n; i++) {
      const cur = edgeTimestamps[(i + 1) % n];
      const prev = edgeTimestamps[i];
      if (cur < prev) {
        backwardJumps++;
        if (backwardJumps > 1) return false;
      }
    }
  }

  // --- Amount constraints ---
  if (edgeAmounts.length >= 2) {
    const mean = edgeAmounts.reduce((s, a) => s + a, 0) / edgeAmounts.length;

    // Minimum mean amount filter
    if (CYCLE_AMOUNT_MIN > 0 && mean < CYCLE_AMOUNT_MIN) return false;

    // Coefficient of variation filter (amount similarity)
    if (CYCLE_AMOUNT_CV_MAX > 0 && mean > 0) {
      const variance = edgeAmounts.reduce((s, a) => s + (a - mean) ** 2, 0) / edgeAmounts.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv > CYCLE_AMOUNT_CV_MAX) return false;
    }

    // Flow conservation ratio: min(amounts)/max(amounts) >= threshold
    if (CYCLE_FLOW_RATIO_MIN > 0 && edgeAmounts.length >= 2) {
      const minAmt = Math.min(...edgeAmounts);
      const maxAmt = Math.max(...edgeAmounts);
      if (maxAmt > 0 && minAmt / maxAmt < CYCLE_FLOW_RATIO_MIN) return false;
    }
  }

  return true;
};

const runCycleDetection = ({ outgoingEdges, outgoingMap, degreeMap }) => {
  const seen = new Set();
  const uniqueCycles = [];

  // Build outgoingMap on demand if not provided (backward compat)
  let adjMap = outgoingMap;
  if (!adjMap) {
    adjMap = new Map();
    for (const [from, edges] of outgoingEdges) {
      const m = new Map();
      for (const e of edges) {
        if (!m.has(e.to)) m.set(e.to, []);
        m.get(e.to).push(e);
      }
      adjMap.set(from, m);
    }
  }

  const uniqueNeighbours = new Map();
  for (const [node, edges] of outgoingEdges) {
    const targets = new Set();
    for (const edge of edges) {
      targets.add(edge.to);
    }
    uniqueNeighbours.set(node, [...targets].sort());
  }

  // Prioritize start nodes by degree (high degree first) to find important cycles
  // before hitting MAX_CYCLES limit; fall back to lexicographic sort for determinism
  const nodeIds = [...uniqueNeighbours.keys()];
  if (degreeMap && degreeMap.size > 0) {
    nodeIds.sort((a, b) => {
      const da = degreeMap.get(a);
      const db = degreeMap.get(b);
      const totalA = da ? da.totalDegree : 0;
      const totalB = db ? db.totalDegree : 0;
      if (totalB !== totalA) return totalB - totalA; // descending degree
      return a.localeCompare(b); // tie-break: lexicographic
    });
  } else {
    nodeIds.sort();
  }

  for (const startNode of nodeIds) {
    if (uniqueCycles.length >= MAX_CYCLES) break;

    const path = [startNode];
    const visited = new Set([startNode]);

    const dfs = (current) => {
      // path already contains current; stop if adding another would exceed limit
      if (path.length > MAX_CYCLE_LENGTH) return false;
      if (uniqueCycles.length >= MAX_CYCLES) return true;

      const neighbours = uniqueNeighbours.get(current);
      if (!neighbours) return false;

      for (const next of neighbours) {
        if (next === startNode && path.length >= MIN_CYCLE_LENGTH) {
          // FIX: Apply temporal/amount filters to the ORIGINAL traversal order (path),
          // not the canonicalized rotation. Canonicalization is only for dedup keys.
          const cyclePath = [...path]; // traversal order
          if (passesCycleFilters(cyclePath, adjMap)) {
            const normalised = normaliseCycle(cyclePath);
            const key = cycleKey(normalised);
            if (!seen.has(key)) {
              seen.add(key);
              // Store both canonical form (for stable IDs) and original path order
              uniqueCycles.push({ normalised, originalPath: cyclePath });
              if (uniqueCycles.length >= MAX_CYCLES) return true;
            }
          }
          continue;
        }

        // Only recurse if adding next keeps path within bounds
        if (!visited.has(next) && path.length < MAX_CYCLE_LENGTH) {
          visited.add(next);
          path.push(next);
          if (dfs(next)) return true;
          path.pop();
          visited.delete(next);
        }
      }
      return false;
    };

    dfs(startNode);
  }

  uniqueCycles.sort((a, b) => cycleKey(a.normalised).localeCompare(cycleKey(b.normalised)));

  const fraudRings = uniqueCycles.map(({ normalised }) => {
    // Stable ID: hash the canonical (sorted-rotation) cycle members
    const canonical = normalised.join('>');
    const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    return {
      ring_id: `RING_${hash.toUpperCase()}`,
      member_accounts: normalised,
      pattern_type: 'cycle',
    };
  });

  return fraudRings;
};

module.exports = { runCycleDetection, normaliseCycle, cycleKey };
