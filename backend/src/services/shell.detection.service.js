const crypto = require('crypto');
const { shell: shellCfg } = require('../config/detectors');
const { pickEdge } = require('../utils/edge.selection.util');

const {
  MAX_CHAIN_DEPTH,
  MIN_CHAIN_LENGTH,
  SHELL_DEGREE_MIN,
  SHELL_DEGREE_MAX,
  SHELL_MIN_IO_RATIO,
  SHELL_AMOUNT_CV_MAX,
  SHELL_TIME_WINDOW_HOURS,
  SHELL_FLOW_TOLERANCE,
} = shellCfg;

/**
 * Determine if nodeId is a plausible shell/pass-through intermediate.
 * Checks total degree bounds AND that it has both incoming and outgoing
 * traffic (in/out ratio) to avoid flagging pure sinks or sources.
 *
 * NOTE: Degree bounds (SHELL_DEGREE_MIN/MAX) are strict. Legitimate
 * pass-through nodes with higher degree will be excluded. Tune via
 * SHELL_DEGREE_MAX env variable if needed.
 */
const isShellIntermediate = (nodeId, degreeMap) => {
  const d = degreeMap.get(nodeId);
  if (!d) return false;
  if (d.totalDegree < SHELL_DEGREE_MIN || d.totalDegree > SHELL_DEGREE_MAX) return false;

  // Require both in and out edges (pass-through pattern)
  if (d.inDegree === 0 || d.outDegree === 0) return false;

  // Check in/out ratio: a shell intermediate should have roughly balanced I/O
  const ratio = Math.min(d.inDegree, d.outDegree) / Math.max(d.inDegree, d.outDegree);
  return ratio >= SHELL_MIN_IO_RATIO;
};

const chainKey = (path) => path.join('>');

/** Produce a stable, deterministic ID from sorted chain members */
const stableChainId = (path) => {
  const canonical = path.join('>');
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `CHAIN_${hash.toUpperCase()}`;
};

/**
 * Validate that a candidate chain has amount flow conservation and temporal
 * continuity. For each consecutive pair in the chain, check that:
 * 1. There exists an edge with a reasonable amount (amounts across hops are similar)
 * 2. Timestamps progress forward in time and fit within the configured window
 * 3. Each intermediate node's sum_in ≈ sum_out (flow tolerance check)
 *
 * Returns true if the chain passes validation, false otherwise.
 */
const passesChainFlowChecks = (path, outgoingMap, nodes) => {
  if (path.length < 2) return false;

  const amounts = [];
  const timestamps = [];

  let prevTs = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const targetMap = outgoingMap.get(from);
    const edges = targetMap ? (targetMap.get(to) || []) : [];
    if (edges.length === 0) return false; // no edge data → can't validate

    // Pick the edge with smallest timestamp >= prevTs for temporal continuity
    const sortedEdges = edges
      .filter((e) => e.timestamp)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (sortedEdges.length === 0) {
      // No timestamped edges for this hop — skip temporal checks but continue
      // validating remaining hops. Collect amount from any available edge.
      if (edges.length > 0 && edges[0].amount != null) {
        const amt = Number(edges[0].amount);
        if (Number.isFinite(amt)) amounts.push(amt);
      }
      continue;
    }

    const chosen = pickEdge(sortedEdges, prevTs);
    if (!chosen) {
      // No valid edge found for this hop — skip temporal checks but continue
      if (edges.length > 0 && edges[0].amount != null) {
        const amt = Number(edges[0].amount);
        if (Number.isFinite(amt)) amounts.push(amt);
      }
      continue;
    }

    prevTs = chosen.timestamp.getTime();
    timestamps.push(chosen.timestamp.getTime());
    if (chosen.amount != null) {
      const amt = Number(chosen.amount);
      if (Number.isFinite(amt)) amounts.push(amt);
    }
  }

  // Temporal window check — only meaningful with >= 2 timestamped hops
  const timeWindowHours = SHELL_TIME_WINDOW_HOURS || 0;
  if (timeWindowHours > 0 && timestamps.length >= 2) {
    const span = (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60);
    if (span > timeWindowHours) return false;
  }

  // Amount conservation check (CV of amounts across hops)
  const amountCvMax = SHELL_AMOUNT_CV_MAX || 0;
  if (amountCvMax > 0 && amounts.length >= 2) {
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    if (mean > 0) {
      const variance = amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv > amountCvMax) return false;
    }
  }

  // Flow tolerance check: for each intermediate node, verify in ≈ out
  if (SHELL_FLOW_TOLERANCE > 0 && nodes) {
    for (let i = 1; i < path.length - 1; i++) {
      const node = nodes.get(path[i]);
      if (node) {
        const sumIn = node.total_incoming;
        const sumOut = node.total_outgoing;
        const maxVal = Math.max(sumIn, sumOut);
        if (maxVal > 0) {
          const diff = Math.abs(sumIn - sumOut) / maxVal;
          if (diff > SHELL_FLOW_TOLERANCE) return false;
        }
      }
    }
  }

  return true;
};

const runShellDetection = (graphContext) => {
  const { outgoingEdges, outgoingMap, degreeMap, nodes } = graphContext;

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

  const seenKeys = new Set();

  const shellChains = [];

  const sortedNodes = [...nodes.keys()].sort();

  for (const startNode of sortedNodes) {
    const stack = [
      {
        path: [startNode],
        visited: new Set([startNode]),
        neighbourIdx: 0,
      },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const current = frame.path[frame.path.length - 1];
      const neighbours = uniqueNeighbours.get(current) || [];

      let pushed = false;

      while (frame.neighbourIdx < neighbours.length) {
        const next = neighbours[frame.neighbourIdx];
        frame.neighbourIdx++;

        if (frame.visited.has(next)) continue;

        // Length AFTER adding next
        const lengthAfterAdd = frame.path.length + 1;

        // Prune: don't exceed max depth
        if (lengthAfterAdd > MAX_CHAIN_DEPTH) continue;

        const nextIsShell = isShellIntermediate(next, degreeMap);
        const candidatePath = [...frame.path, next];

        // Check if candidate path meets minimum length
        if (lengthAfterAdd >= MIN_CHAIN_LENGTH) {
          // Only intermediate nodes (indexes 1..length-2) must be shell intermediates.
          // The first and last nodes in the chain can be any account type
          // (they represent the source and sink of the pass-through flow).
          let allIntermediatesValid = true;
          for (let i = 1; i < candidatePath.length - 1; i++) {
            if (!isShellIntermediate(candidatePath[i], degreeMap)) {
              allIntermediatesValid = false;
              break;
            }
          }
          if (allIntermediatesValid) {
            const key = chainKey(candidatePath);
            if (!seenKeys.has(key)) {
              // Validate amount flow conservation and temporal continuity
              if (passesChainFlowChecks(candidatePath, adjMap, nodes)) {
                seenKeys.add(key);
                shellChains.push({
                  chain_id: stableChainId(candidatePath),
                  path: candidatePath,
                  pattern_type: 'shell_chain',
                });
              }
            }
          }
        }

        // Continue extending only if within depth and next node is a shell intermediate
        if (lengthAfterAdd < MAX_CHAIN_DEPTH && nextIsShell) {
          // Pruning: check cumulative amount variance before extending further
          // This prevents combinatorial explosion in near-complete graphs
          const amountCvMax = SHELL_AMOUNT_CV_MAX || 0;
          if (amountCvMax > 0 && candidatePath.length >= 3) {
            const pathAmounts = [];
            let skipExtend = false;
            let pPrevTs = 0;
            for (let pi = 0; pi < candidatePath.length - 1; pi++) {
              const fNode = candidatePath[pi];
              const tNode = candidatePath[pi + 1];
              const tgtMap = adjMap.get(fNode);
              const pEdges = tgtMap ? (tgtMap.get(tNode) || []) : [];
              if (pEdges.length > 0) {
                // Use the same edge-selection policy as passesChainFlowChecks
                const pSorted = pEdges
                  .filter((e) => e.timestamp)
                  .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                const pChosen = pSorted.length > 0 ? pickEdge(pSorted, pPrevTs) : pEdges[0];
                pathAmounts.push(pChosen.amount || 0);
                if (pChosen.timestamp) pPrevTs = pChosen.timestamp.getTime();
              }
            }
            if (pathAmounts.length >= 2) {
              const pMean = pathAmounts.reduce((s, a) => s + a, 0) / pathAmounts.length;
              if (pMean > 0) {
                const pVar = pathAmounts.reduce((s, a) => s + (a - pMean) ** 2, 0) / pathAmounts.length;
                const pCv = Math.sqrt(pVar) / pMean;
                if (pCv > amountCvMax * 1.5) skipExtend = true; // looser threshold for pruning
              }
            }
            if (skipExtend) continue;
          }

          const newVisited = new Set(frame.visited);
          newVisited.add(next);
          stack.push({
            path: candidatePath,
            visited: newVisited,
            neighbourIdx: 0,
          });
          pushed = true;
          break;
        }
      }

      if (!pushed) {
        stack.pop();
      }
    }
  }

  const maximalChains = filterMaximalChains(shellChains);

  maximalChains.sort((a, b) => chainKey(a.path).localeCompare(chainKey(b.path)));
  // Assign stable IDs based on canonical path hash
  maximalChains.forEach((chain) => {
    chain.chain_id = stableChainId(chain.path);
  });

  const shellResults = {
    shellChains: maximalChains,
  };

  graphContext.shellResults = shellResults;

  return shellResults;
};

/**
 * Remove subchains that are contained within longer chains.
 * NOTE: Subsumption detection uses MIN_CHAIN_LENGTH as the minimum subsequence
 * length to mark. If MIN_CHAIN_LENGTH changes, the subsumption semantics change
 * accordingly (shorter subsequences below MIN_CHAIN_LENGTH are never detected
 * as standalone chains anyway, so they don't need to be subsumed).
 */
const filterMaximalChains = (chains) => {
  const sorted = [...chains].sort((a, b) => b.path.length - a.path.length);

  const maximal = [];
  const subsumedKeys = new Set();

  for (const chain of sorted) {
    const key = chain.path.join('>');

    if (subsumedKeys.has(key)) continue;

    maximal.push(chain);

    for (let start = 0; start < chain.path.length; start++) {
      for (let end = start + MIN_CHAIN_LENGTH; end <= chain.path.length; end++) {
        if (end - start === chain.path.length) continue;
        subsumedKeys.add(chain.path.slice(start, end).join('>'));
      }
    }
  }

  return maximal;
};

module.exports = { runShellDetection };
