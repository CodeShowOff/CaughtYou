import { useMemo } from 'react';

function findSuspiciousAccount(accountId, suspiciousAccounts) {
  if (!suspiciousAccounts) return null;
  return suspiciousAccounts.find((sa) => sa.account_id === accountId) || null;
}

function AccountDetailsPanel({ selectedAccount, suspiciousAccounts, onClose }) {
  const accountData = useMemo(
    () =>
      selectedAccount
        ? findSuspiciousAccount(selectedAccount.id, suspiciousAccounts)
        : null,
    [selectedAccount, suspiciousAccounts],
  );

  if (!selectedAccount) return null;

  const isSuspicious = selectedAccount.isSuspicious;

  return (
    <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-5 w-80 flex-shrink-0 self-start sticky top-20 animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-sm font-semibold text-slate-800 uppercase tracking-wide flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-6-3a2 2 0 11-4 0 2 2 0 014 0zm-2 4a5 5 0 00-4.546 2.916A5.986 5.986 0 0010 16a5.986 5.986 0 004.546-2.084A5 5 0 0010 11z" clipRule="evenodd" />
          </svg>
          Investigation
        </h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-md hover:bg-slate-100"
          aria-label="Close panel"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      </div>


      <div className="mb-4">
        <p className="text-xs text-slate-500 mb-1">Account ID</p>
        <p className="text-sm font-medium text-slate-900 font-mono bg-slate-50 px-2.5 py-1.5 rounded-md border border-slate-100">
          {selectedAccount.id}
        </p>
      </div>

      <div className="mb-4">
        <p className="text-xs text-slate-500 mb-1">Status</p>
        {isSuspicious ? (
          <span className="inline-flex items-center gap-1.5 bg-red-50 text-red-700 text-xs font-medium px-2.5 py-1.5 rounded-md ring-1 ring-red-200">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            Suspicious
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 bg-green-50 text-green-700 text-xs font-medium px-2.5 py-1.5 rounded-md ring-1 ring-green-200">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Normal
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
          <p className="text-xs text-slate-500 mb-0.5">Score</p>
          <p className={`text-lg font-bold ${isSuspicious ? 'text-red-600' : 'text-slate-400'}`}>
            {isSuspicious && accountData ? accountData.suspicion_score : '—'}
          </p>
        </div>
        <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
          <p className="text-xs text-slate-500 mb-0.5">Ring ID</p>
          <p className="text-xs font-medium text-slate-800 font-mono truncate" title={isSuspicious && accountData ? accountData.ring_id : '—'}>
            {isSuspicious && accountData ? accountData.ring_id : '—'}
          </p>
        </div>
      </div>

      <div>
        <p className="text-xs text-slate-500 mb-2">Detected Patterns</p>
        {isSuspicious && accountData && accountData.detected_patterns.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {accountData.detected_patterns.map((pattern) => {
              const colorMap = {
                fan_in: 'bg-amber-50 text-amber-700 ring-amber-200',
                fan_out: 'bg-purple-50 text-purple-700 ring-purple-200',
                shell_chain: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
                mule_chain: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
                high_velocity: 'bg-rose-50 text-rose-700 ring-rose-200',
                high_amount: 'bg-orange-50 text-orange-700 ring-orange-200',
              };
              const cls = pattern.startsWith('cycle_length')
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : colorMap[pattern] || 'bg-red-50 text-red-600 ring-red-200';
              return (
                <span
                  key={pattern}
                  className={`${cls} text-xs font-medium px-2 py-1 rounded-md ring-1`}
                >
                  {pattern.replace(/_/g, ' ')}
                </span>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-slate-400 italic">None detected</p>
        )}
      </div>

      {isSuspicious && accountData && (
        <>
          <div className="grid grid-cols-2 gap-3 mt-4 mb-4">
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500 mb-0.5">Confidence</p>
              <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-semibold ${
                accountData.confidence === 'high' ? 'text-red-700 bg-red-50 ring-1 ring-red-200' :
                accountData.confidence === 'medium' ? 'text-amber-700 bg-amber-50 ring-1 ring-amber-200' :
                'text-green-700 bg-green-50 ring-1 ring-green-200'
              }`}>
                {accountData.confidence}
              </span>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500 mb-0.5">Detectors</p>
              <p className="text-lg font-bold text-slate-800">{accountData.detector_count}</p>
            </div>
          </div>

          {Object.values(accountData.sub_scores).some((v) => v > 0) && (
            <div className="mb-4">
              <p className="text-xs text-slate-500 mb-2">Score Breakdown</p>
              <div className="space-y-1.5">
                {Object.entries(accountData.sub_scores)
                  .filter(([, v]) => v > 0)
                  .map(([key, val]) => (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-xs text-slate-500 capitalize">{key.replace(/_/g, ' ')}</span>
                      <span className="text-xs font-semibold text-slate-700">+{val}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {accountData.key_metrics && (
            <div className="mb-4">
              <p className="text-xs text-slate-500 mb-2">Key Metrics</p>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="bg-slate-50 rounded p-2 border border-slate-100">
                  <p className="text-[10px] text-slate-400">Incoming</p>
                  <p className="text-xs font-medium text-slate-700">{accountData.key_metrics.sum_incoming.toLocaleString()}</p>
                </div>
                <div className="bg-slate-50 rounded p-2 border border-slate-100">
                  <p className="text-[10px] text-slate-400">Outgoing</p>
                  <p className="text-xs font-medium text-slate-700">{accountData.key_metrics.sum_outgoing.toLocaleString()}</p>
                </div>
                <div className="bg-slate-50 rounded p-2 border border-slate-100">
                  <p className="text-[10px] text-slate-400">In Partners</p>
                  <p className="text-xs font-medium text-slate-700">{accountData.key_metrics.unique_counterparties_in}</p>
                </div>
                <div className="bg-slate-50 rounded p-2 border border-slate-100">
                  <p className="text-[10px] text-slate-400">Out Partners</p>
                  <p className="text-xs font-medium text-slate-700">{accountData.key_metrics.unique_counterparties_out}</p>
                </div>
                <div className="bg-slate-50 rounded p-2 border border-slate-100">
                  <p className="text-[10px] text-slate-400">Total Txns</p>
                  <p className="text-xs font-medium text-slate-700">{accountData.key_metrics.transaction_count}</p>
                </div>
                <div className="bg-slate-50 rounded p-2 border border-slate-100">
                  <p className="text-[10px] text-slate-400">Peak Velocity</p>
                  <p className="text-xs font-medium text-slate-700">{accountData.key_metrics.peak_velocity_tx_per_hour} tx/h</p>
                </div>
              </div>
            </div>
          )}

          {accountData.reason_codes && accountData.reason_codes.length > 0 && (
            <div>
              <p className="text-xs text-slate-500 mb-2">Reason Codes</p>
              <div className="flex flex-wrap gap-1">
                {accountData.reason_codes.map((code, i) => (
                  <span key={i} className="bg-slate-100 text-slate-600 text-[10px] font-mono px-1.5 py-0.5 rounded">
                    {code}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default AccountDetailsPanel;
