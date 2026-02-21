import { useState } from 'react';

const PREVIEW_ROWS = 15;

function CsvPreview({ rows, fileName, totalRows }) {
  const [visibleCount, setVisibleCount] = useState(PREVIEW_ROWS);

  if (!rows || rows.length === 0) return null;

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const displayed = dataRows.slice(0, visibleCount);
  const hasMore = visibleCount < dataRows.length;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 w-full max-w-xl animate-fade-in flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-emerald-500 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800 truncate" title={fileName}>
              {fileName}
            </p>
            <p className="text-xs text-slate-400">
              {totalRows.toLocaleString()} row{totalRows !== 1 ? 's' : ''} &middot; {headers.length} column{headers.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
      </div>

      <div className="overflow-auto rounded-lg border border-slate-200 flex-1" style={{ maxHeight: 380 }}>
        <table className="min-w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-slate-100">
              <th className="px-2.5 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200 w-8">
                #
              </th>
              {headers.map((h, i) => (
                <th
                  key={i}
                  className="px-2.5 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200 whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayed.map((row, rIdx) => (
              <tr
                key={rIdx}
                className={`${rIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/60'} hover:bg-blue-50/40 transition-colors`}
              >
                <td className="px-2.5 py-1.5 text-slate-400 font-mono border-r border-slate-100">
                  {rIdx + 1}
                </td>
                {headers.map((_, cIdx) => (
                  <td
                    key={cIdx}
                    className="px-2.5 py-1.5 text-slate-700 whitespace-nowrap max-w-[180px] truncate"
                    title={row[cIdx] ?? ''}
                  >
                    {row[cIdx] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
        <span>
          Showing {Math.min(displayed.length, dataRows.length)} of {totalRows.toLocaleString()} rows
        </span>
        {hasMore && (
          <button
            onClick={() => setVisibleCount((c) => c + 50)}
            className="text-blue-500 hover:text-blue-700 font-medium"
          >
            Show more
          </button>
        )}
      </div>
    </div>
  );
}

export default CsvPreview;
