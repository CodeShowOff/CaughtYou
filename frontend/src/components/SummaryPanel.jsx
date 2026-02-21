import { useMemo, useState, useCallback } from 'react';
import { downloadJSONExport } from '../api/axiosClient';

const PAGE_SIZE = 50;

function riskLevel(score) {
  if (score >= 70) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function riskBadge(score) {
  const val = Number(score.toFixed(1));
  const map = {
    high:   'text-red-700 bg-red-50 ring-1 ring-red-200',
    medium: 'text-amber-700 bg-amber-50 ring-1 ring-amber-200',
    low:    'text-green-700 bg-green-50 ring-1 ring-green-200',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-semibold ${map[riskLevel(val)]}`}>
      {val}
    </span>
  );
}

function patternBadge(type) {
  const map = {
    cycle:       'bg-emerald-50 text-emerald-700 ring-emerald-200',
    fan_in:      'bg-amber-50 text-amber-700 ring-amber-200',
    fan_out:     'bg-purple-50 text-purple-700 ring-purple-200',
    shell_chain: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  };
  const cls = map[type] || 'bg-slate-50 text-slate-600 ring-slate-200';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium ring-1 ${cls}`}>
      {type?.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * Merge fraud rings that share common accounts into a single combined ring.
 * Uses Union-Find to group overlapping rings efficiently.
 */
function mergeOverlappingRings(fraudRings) {
  if (!fraudRings || fraudRings.length === 0) return [];

  // Union-Find
  const parent = new Map();
  const rank = new Map();

  function find(x) {
    if (!parent.has(x)) { parent.set(x, x); rank.set(x, 0); }
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rankA = rank.get(ra);
    const rankB = rank.get(rb);
    if (rankA < rankB) { parent.set(ra, rb); }
    else if (rankA > rankB) { parent.set(rb, ra); }
    else { parent.set(rb, ra); rank.set(ra, rankA + 1); }
  }

  // Map each account to the ring indices it belongs to
  const accountToRings = new Map();
  fraudRings.forEach((ring, idx) => {
    for (const acc of ring.member_accounts) {
      if (!accountToRings.has(acc)) accountToRings.set(acc, []);
      accountToRings.get(acc).push(idx);
    }
  });

  // Union ring indices that share at least one account
  for (const ringIndices of accountToRings.values()) {
    for (let i = 1; i < ringIndices.length; i++) {
      union(ringIndices[0], ringIndices[i]);
    }
  }

  // Group rings by their root
  const groups = new Map();
  fraudRings.forEach((ring, idx) => {
    const root = find(idx);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(ring);
  });

  // Build merged rings
  const merged = [];
  for (const group of groups.values()) {
    const allAccounts = new Set();
    const allPatterns = new Set();
    let maxScore = 0;
    const subRingIds = [];

    for (const ring of group) {
      for (const acc of ring.member_accounts) allAccounts.add(acc);
      allPatterns.add(ring.pattern_type);
      if (ring.risk_score > maxScore) maxScore = ring.risk_score;
      subRingIds.push(ring.ring_id);
    }

    const patternTypes = [...allPatterns].sort();

    merged.push({
      ring_id: subRingIds.sort().join('+'),
      pattern_type: patternTypes.length === 1 ? patternTypes[0] : patternTypes.join(', '),
      pattern_types: patternTypes,
      member_accounts: [...allAccounts].sort(),
      risk_score: maxScore,
      sub_ring_ids: subRingIds,
      sub_rings: group,
    });
  }

  return merged;
}

function RingIdCell({ ring, isHighlighted }) {
  const [open, setOpen] = useState(false);
  const ids = ring.sub_ring_ids || [ring.ring_id];
  const primary = ids[0];
  const rest = ids.slice(1);

  return (
    <div className="relative">
      <span className={`inline-flex items-center gap-1.5 ${
        isHighlighted ? 'text-orange-600' : 'text-blue-600 hover:text-blue-800'
      }`}>
        {isHighlighted && (
          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
        )}
        {primary}
        {rest.length > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen((p) => !p); }}
            className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700 transition-colors"
          >
            +{rest.length}
          </button>
        )}
      </span>
      {open && rest.length > 0 && (
        <div className="absolute left-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[200px]">
          {rest.map((id) => (
            <div key={id} className="px-3 py-1.5 text-xs font-mono text-slate-600 hover:bg-slate-50 truncate">
              {id}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MemberAccountsCell({ accounts }) {
  const [expanded, setExpanded] = useState(false);
  const display = accounts.join(', ');
  if (display.length <= 60) {
    return <span className="text-xs text-slate-500">{display}</span>;
  }
  return (
    <div>
      <span className="text-xs text-slate-500">
        {expanded ? display : `${display.slice(0, 60)}…`}
      </span>
      <button
        onClick={() => setExpanded((p) => !p)}
        className="ml-1 text-xs text-blue-500 hover:text-blue-700 font-medium"
      >
        {expanded ? 'Less' : `+${accounts.length} more`}
      </button>
    </div>
  );
}

function SortIcon({ active, direction }) {
  if (!active) {
    return (
      <svg className="inline ml-1 h-3 w-3 text-slate-300" viewBox="0 0 12 12" fill="currentColor">
        <path d="M6 1l3 4H3zM6 11l-3-4h6z" />
      </svg>
    );
  }
  return (
    <svg className="inline ml-1 h-3 w-3 text-blue-500" viewBox="0 0 12 12" fill="currentColor">
      {direction === 'asc' ? <path d="M6 2l4 5H2z" /> : <path d="M6 10l-4-5h8z" />}
    </svg>
  );
}

function SummaryPanel({ fraudRings, onRingSelect, highlightedRingId }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  const [page, setPage] = useState(0);

  const [searchQuery, setSearchQuery] = useState('');
  const [patternFilter, setPatternFilter] = useState('all');
  const [riskFilter, setRiskFilter] = useState('all');

  const [sortKey, setSortKey] = useState('risk_score');
  const [sortDir, setSortDir] = useState('desc');

  // Merge overlapping rings that share accounts
  const mergedRings = useMemo(() => mergeOverlappingRings(fraudRings), [fraudRings]);

  const patternTypes = useMemo(() => {
    if (!mergedRings) return [];
    const types = new Set();
    for (const r of mergedRings) {
      for (const pt of r.pattern_types) types.add(pt);
    }
    return [...types].sort();
  }, [mergedRings]);

  const processedRings = useMemo(() => {
    if (!mergedRings || mergedRings.length === 0) return [];

    let rings = [...mergedRings];

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      rings = rings.filter(
        (r) =>
          r.ring_id.toLowerCase().includes(q) ||
          r.member_accounts.some((a) => a.toLowerCase().includes(q)),
      );
    }

    if (patternFilter !== 'all') {
      rings = rings.filter((r) => r.pattern_types.includes(patternFilter));
    }

    if (riskFilter !== 'all') {
      rings = rings.filter((r) => riskLevel(r.risk_score) === riskFilter);
    }

    rings.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'ring_id':
          cmp = a.ring_id.localeCompare(b.ring_id);
          break;
        case 'pattern_type':
          cmp = (a.pattern_types.join(',')).localeCompare(b.pattern_types.join(','));
          break;
        case 'member_count':
          cmp = a.member_accounts.length - b.member_accounts.length;
          break;
        case 'risk_score':
        default:
          cmp = a.risk_score - b.risk_score;
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return rings;
  }, [mergedRings, searchQuery, patternFilter, riskFilter, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(processedRings.length / PAGE_SIZE));
  const pagedRings = useMemo(
    () => processedRings.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [processedRings, page],
  );

  const [prevRings, setPrevRings] = useState(fraudRings);
  if (fraudRings !== prevRings) {
    setPrevRings(fraudRings);
    setPage(0);
    setSearchQuery('');
    setPatternFilter('all');
    setRiskFilter('all');
  }

  const hasResults = processedRings.length > 0;
  const hasData = mergedRings && mergedRings.length > 0;

  const handleSort = useCallback(
    (key) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir(key === 'ring_id' ? 'asc' : 'desc');
      }
      setPage(0);
    },
    [sortKey],
  );

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await downloadJSONExport();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'financial_forensics_output.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      setDownloadError('Download failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  }, []);

  const thClass =
    'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider cursor-pointer select-none hover:bg-slate-200/60 transition-colors';

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 w-full">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Fraud Ring Summary</h2>
          {hasData && (
            <p className="text-xs text-slate-400 mt-0.5">
              {mergedRings.length} merged ring{mergedRings.length !== 1 ? 's' : ''}
              {fraudRings && mergedRings.length !== fraudRings.length && (
                <> &middot; from {fraudRings.length} pattern{fraudRings.length !== 1 ? 's' : ''}</>
              )}
              {processedRings.length !== mergedRings.length && (
                <> &middot; {processedRings.length} shown</>
              )}
            </p>
          )}
        </div>

        {hasData && (
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors flex items-center gap-2 self-start"
          >
            {downloading ? (
              <>
                <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Preparing…
              </>
            ) : (
              <>
                <svg className="h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
                Export JSON
              </>
            )}
          </button>
        )}
      </div>

      {downloadError && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm flex items-center justify-between">
          <span>{downloadError}</span>
          <button onClick={() => setDownloadError(null)} className="text-red-400 hover:text-red-600 ml-2 text-xs font-medium">
            Dismiss
          </button>
        </div>
      )}

      {hasData && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4 pb-4 border-b border-slate-100">
          <div className="relative flex-1 max-w-xs">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
            </svg>
            <input
              type="text"
              placeholder="Search rings or accounts…"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 bg-slate-50 placeholder-slate-400 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); setPage(0); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-slate-500 font-medium mr-1">Pattern:</span>
            <button
              onClick={() => { setPatternFilter('all'); setPage(0); }}
              className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                patternFilter === 'all'
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              All
            </button>
            {patternTypes.map((type) => (
              <button
                key={type}
                onClick={() => { setPatternFilter(type); setPage(0); }}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                  patternFilter === type
                    ? 'bg-slate-800 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {type?.replace(/_/g, ' ')}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500 font-medium mr-1">Risk:</span>
            {['all', 'high', 'medium', 'low'].map((level) => (
              <button
                key={level}
                onClick={() => { setRiskFilter(level); setPage(0); }}
                className={`px-2.5 py-1 text-xs rounded-md font-medium capitalize transition-all ${
                  riskFilter === level
                    ? 'bg-slate-800 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {level === 'all' ? 'All' : level}
              </button>
            ))}
          </div>
        </div>
      )}

      {!hasData ? (
        <p className="text-sm text-slate-400 text-center py-8">
          No fraud rings detected yet.
        </p>
      ) : !hasResults ? (
        <p className="text-sm text-slate-400 text-center py-8">
          No rings match your current filters.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-600">
                <th className={thClass} onClick={() => handleSort('ring_id')}>
                  Ring ID <SortIcon active={sortKey === 'ring_id'} direction={sortDir} />
                </th>
                <th className={thClass} onClick={() => handleSort('pattern_type')}>
                  Patterns <SortIcon active={sortKey === 'pattern_type'} direction={sortDir} />
                </th>
                <th className={`${thClass} text-right`} onClick={() => handleSort('member_count')}>
                  Members <SortIcon active={sortKey === 'member_count'} direction={sortDir} />
                </th>
                <th className={`${thClass} text-right`} onClick={() => handleSort('risk_score')}>
                  Risk Score <SortIcon active={sortKey === 'risk_score'} direction={sortDir} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
                  Accounts
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedRings.map((ring) => {
                const isHighlighted = highlightedRingId === ring.ring_id ||
                  (ring.sub_ring_ids && ring.sub_ring_ids.includes(highlightedRingId));
                return (
                <tr
                  key={ring.ring_id}
                  className={`border-t border-slate-100 transition-colors cursor-pointer ${
                    isHighlighted
                      ? 'bg-orange-50 hover:bg-orange-100/60'
                      : 'hover:bg-blue-50/40'
                  }`}
                  onClick={() => onRingSelect?.(ring)}
                >
                  <td className="px-4 py-3 font-medium font-mono text-xs">
                    <RingIdCell ring={ring} isHighlighted={isHighlighted} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {ring.pattern_types.map((pt) => (
                        <span key={pt}>{patternBadge(pt)}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600">
                    {ring.member_accounts.length}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {riskBadge(ring.risk_score)}
                  </td>
                  <td className="px-4 py-3 max-w-sm">
                    <MemberAccountsCell accounts={ring.member_accounts} />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>

          {processedRings.length > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4 text-sm text-slate-600">
              <span>
                Showing {page * PAGE_SIZE + 1}–
                {Math.min((page + 1) * PAGE_SIZE, processedRings.length)} of{' '}
                {processedRings.length} rings
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage(0)}
                  disabled={page === 0}
                  className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                >
                  First
                </button>
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1 rounded border border-slate-200 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Prev
                </button>
                <span className="px-3 py-1 text-slate-500">
                  {page + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-3 py-1 rounded border border-slate-200 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
                <button
                  onClick={() => setPage(totalPages - 1)}
                  disabled={page >= totalPages - 1}
                  className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                >
                  Last
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SummaryPanel;
