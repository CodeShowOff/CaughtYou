/**
 * Unified edge-selection policy used across cycle and shell detectors.
 *
 * Given a list of edges (already sorted ascending by timestamp) and a
 * minimum timestamp (`prevTs`), returns the canonical "chosen" edge:
 *
 *   1. Prefer the *earliest* edge with `timestamp >= prevTs` (monotonic pick).
 *   2. If no such edge exists, fall back to the *earliest* overall
 *      (wrap-around / non-monotonic pick).
 *
 * This ensures every detector agrees on the same temporal heuristic and
 * avoids inconsistencies between cycle / shell / smurfing detectors.
 *
 * @param {Array} sortedEdges - edges sorted ascending by timestamp (all must have `.timestamp`)
 * @param {number} prevTs     - minimum acceptable timestamp (epoch ms); 0 = no constraint
 * @returns {object|null}     - selected edge, or null if the array is empty
 */
const pickEdge = (sortedEdges, prevTs = 0) => {
  if (!sortedEdges || sortedEdges.length === 0) return null;

  for (const e of sortedEdges) {
    if (e.timestamp.getTime() >= prevTs) {
      return e;
    }
  }

  // Wrap-around: pick earliest overall
  return sortedEdges[0];
};

module.exports = { pickEdge };
