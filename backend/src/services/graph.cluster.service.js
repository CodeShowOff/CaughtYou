const buildFraudClusters = (graphContext) => {
  const { unifiedFraudRings } = graphContext;

  if (!unifiedFraudRings || unifiedFraudRings.length === 0) {
    graphContext.fraudClusters = [];
    return [];
  }

  const accountToRings = new Map();

  for (const ring of unifiedFraudRings) {
    for (const acc of ring.member_accounts) {
      if (!accountToRings.has(acc)) accountToRings.set(acc, []);
      accountToRings.get(acc).push(ring.ring_id);
    }
  }

  const ringAdj = new Map();
  for (const ring of unifiedFraudRings) {
    ringAdj.set(ring.ring_id, new Set());
  }

  for (const rings of accountToRings.values()) {
    for (let i = 0; i < rings.length; i++) {
      for (let j = i + 1; j < rings.length; j++) {
        ringAdj.get(rings[i]).add(rings[j]);
        ringAdj.get(rings[j]).add(rings[i]);
      }
    }
  }

  const visited = new Set();
  const clusters = [];

  const ringLookup = new Map(
    unifiedFraudRings.map(r => [r.ring_id, r])
  );

  const sortedRingIds = [...ringAdj.keys()].sort();

  for (const start of sortedRingIds) {
    if (visited.has(start)) continue;

    const stack = [start];
    const clusterRingIds = new Set();
    const clusterAccounts = new Set();

    while (stack.length) {
      const r = stack.pop();
      if (visited.has(r)) continue;
      visited.add(r);

      const ring = ringLookup.get(r);
      if (!ring) {
        // Ring referenced in adjacency but missing from unifiedFraudRings
        // (may have been filtered/merged upstream) — skip gracefully
        continue;
      }

      clusterRingIds.add(r);
      for (const acc of ring.member_accounts) {
        clusterAccounts.add(acc);
      }

      for (const nbr of ringAdj.get(r)) {
        if (!visited.has(nbr)) stack.push(nbr);
      }
    }

    clusters.push({
      cluster_id: `CLUSTER_TEMP_${String(clusters.length + 1).padStart(3,'0')}`,
      ring_ids: [...clusterRingIds].sort(),
      member_accounts: [...clusterAccounts].sort(),
    });
  }

  // Sort clusters deterministically by member accounts.
  // Use '|' as delimiter (less likely to appear in account IDs than '>').
  clusters.sort((a,b) =>
    a.member_accounts.join('|').localeCompare(b.member_accounts.join('|'))
  );

  clusters.forEach((c,idx) => {
    c.cluster_id = `CLUSTER_${String(idx+1).padStart(3,'0')}`;
  });

  graphContext.fraudClusters = clusters;

  return clusters;
};

module.exports = { buildFraudClusters };
