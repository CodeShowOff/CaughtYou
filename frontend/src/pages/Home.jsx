import { useState, useCallback, useRef, useMemo } from 'react';
import useUpload from '../hooks/useUpload.js';
import UploadCard from '../components/UploadCard.jsx';
import CsvPreview from '../components/CsvPreview.jsx';
import GraphContainer from '../components/GraphContainer.jsx';
import AccountDetailsPanel from '../components/AccountDetailsPanel.jsx';
import SummaryPanel from '../components/SummaryPanel.jsx';

const PATTERN_LABELS = {
  all: 'All Patterns',
  cycle: 'Cycles',
  fan_in: 'Fan-In',
  fan_out: 'Fan-Out',
  shell_chain: 'Shell Chains',
  suspicious: 'Suspicious Only',
};

function filterGraphData(graphData, filter) {
  if (!graphData || filter === 'all') return graphData;

  if (filter === 'suspicious') {
    const ids = new Set(graphData.suspicious_accounts.map((sa) => sa.account_id));
    return {
      ...graphData,
      nodes: graphData.nodes.filter((n) => ids.has(n)),
      edges: graphData.edges.filter((e) => ids.has(e.sender_id) && ids.has(e.receiver_id)),
      fraud_rings: graphData.fraud_rings.filter((r) =>
        r.member_accounts.some((a) => ids.has(a)),
      ),
    };
  }

  const filteredRings = graphData.fraud_rings.filter((r) => r.pattern_type === filter);
  const memberAccounts = new Set();
  filteredRings.forEach((ring) => ring.member_accounts.forEach((a) => memberAccounts.add(a)));

  return {
    ...graphData,
    nodes: graphData.nodes.filter((n) => memberAccounts.has(n)),
    edges: graphData.edges.filter(
      (e) => memberAccounts.has(e.sender_id) && memberAccounts.has(e.receiver_id),
    ),
    fraud_rings: filteredRings,
    suspicious_accounts: graphData.suspicious_accounts.filter((sa) =>
      memberAccounts.has(sa.account_id),
    ),
  };
}

function Home() {
  const { loading, data, graphData, error, uploadCSV } = useUpload();
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [highlightedRing, setHighlightedRing] = useState(null);
  const [csvPreview, setCsvPreview] = useState(null);

  const parseCsvForPreview = useCallback((file) => {
    if (!file) { setCsvPreview(null); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const rows = lines.slice(0, 201).map((line) => {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
            else if (ch === '"') inQuotes = false;
            else current += ch;
          } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') { result.push(current.trim()); current = ''; }
            else current += ch;
          }
        }
        result.push(current.trim());
        return result;
      });
      setCsvPreview({ rows, fileName: file.name, totalRows: lines.length - 1 });
    };
    const slice = file.slice(0, 100_000);
    reader.readAsText(slice);
  }, []);

  const handleUpload = useCallback((file) => {
    parseCsvForPreview(file);
    uploadCSV(file);
  }, [parseCsvForPreview, uploadCSV]);

  const handleNodeSelect = useCallback((accountData) => {
    setSelectedAccount(accountData);
  }, []);

  const prevGraphData = useRef(graphData);
  if (graphData !== prevGraphData.current) {
    prevGraphData.current = graphData;
    if (selectedAccount) setSelectedAccount(null);
    setActiveFilter('all');
    setHighlightedRing(null);
  }

  const handleClosePanel = useCallback(() => {
    setSelectedAccount(null);
  }, []);

  const handleRingSelect = useCallback((ring) => {
    setHighlightedRing((prev) => (prev?.ring_id === ring?.ring_id ? null : ring));
  }, []);

  const handleRingClear = useCallback(() => {
    setHighlightedRing(null);
  }, []);

  const availableFilters = useMemo(() => {
    if (!graphData?.fraud_rings) return ['all'];
    const types = new Set(graphData.fraud_rings.map((r) => r.pattern_type));
    const filters = ['all'];
    if (types.has('cycle')) filters.push('cycle');
    if (types.has('fan_in')) filters.push('fan_in');
    if (types.has('fan_out')) filters.push('fan_out');
    if (types.has('shell_chain')) filters.push('shell_chain');
    if (graphData.suspicious_accounts?.length > 0) filters.push('suspicious');
    return filters;
  }, [graphData]);

  const filteredGraphData = useMemo(
    () => filterGraphData(graphData, activeFilter),
    [graphData, activeFilter],
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <header className="bg-white/80 backdrop-blur-sm border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-sm">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                <path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 leading-tight">CaughtYou</h1>
              <p className="text-xs text-slate-500">Financial Forensics Engine</p>
            </div>
          </div>
          {data?.success && (
            <div className="hidden sm:flex items-center gap-4 text-xs text-slate-500">
              <span>{data.total_transactions?.toLocaleString()} txns</span>
              <span className="text-slate-300">|</span>
              <span>{data.total_accounts?.toLocaleString()} accounts</span>
              <span className="text-slate-300">|</span>
              <span className="text-red-500 font-medium">{data.fraud_rings_count} rings</span>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        <div className={`flex gap-6 items-stretch ${csvPreview ? 'justify-center' : ''}`}>
          <UploadCard loading={loading} data={data} error={error} onUpload={handleUpload} onFileSelect={parseCsvForPreview} />
          {csvPreview && (
            <CsvPreview
              rows={csvPreview.rows}
              fileName={csvPreview.fileName}
              totalRows={csvPreview.totalRows}
            />
          )}
        </div>

        {data?.success && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 animate-fade-in">
            <StatCard label="Transactions" value={data.total_transactions} color="blue" />
            <StatCard label="Accounts" value={data.total_accounts} color="indigo" />
            <StatCard label="Suspicious" value={data.suspicious_accounts_count} color="red" />
            <StatCard label="Fraud Rings" value={data.fraud_rings_count} color="amber" />
            <StatCard label="Clusters" value={data.fraud_clusters_count} color="purple" />
          </div>
        )}

        <div className="flex gap-6 items-start">
          <div className="flex-1 min-w-0">
            <GraphContainer
              graphData={filteredGraphData}
              rawGraphData={graphData}
              onNodeSelect={handleNodeSelect}
              activeFilter={activeFilter}
              onFilterChange={setActiveFilter}
              availableFilters={availableFilters}
              filterLabels={PATTERN_LABELS}
              highlightedRing={highlightedRing}
              onRingClear={handleRingClear}
            />
          </div>

          {selectedAccount && (
            <AccountDetailsPanel
              selectedAccount={selectedAccount}
              suspiciousAccounts={graphData?.suspicious_accounts}
              onClose={handleClosePanel}
            />
          )}
        </div>

        <SummaryPanel
          fraudRings={graphData?.fraud_rings}
          onRingSelect={handleRingSelect}
          highlightedRingId={highlightedRing?.ring_id}
        />

        <footer className="text-center pt-6 pb-8">
          <p className="text-xs text-slate-400">
            CaughtYou &mdash; Advanced Financial Forensics & Analytics Platform
          </p>
        </footer>
      </main>
    </div>
  );
}

const COLOR_MAP = {
  blue:   { bg: 'bg-blue-50',   text: 'text-blue-600',   border: 'border-blue-100' },
  indigo: { bg: 'bg-indigo-50', text: 'text-indigo-600', border: 'border-indigo-100' },
  red:    { bg: 'bg-red-50',    text: 'text-red-600',    border: 'border-red-100' },
  amber:  { bg: 'bg-amber-50',  text: 'text-amber-600',  border: 'border-amber-100' },
  purple: { bg: 'bg-purple-50', text: 'text-purple-600', border: 'border-purple-100' },
};

function StatCard({ label, value, color }) {
  const c = COLOR_MAP[color] || COLOR_MAP.blue;
  return (
    <div className={`bg-white rounded-xl shadow-sm border ${c.border} p-4`}>
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${c.text}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  );
}

export default Home;
