import { useRef, useState, useCallback } from 'react';

const SAMPLE_DATASETS = [
  { label: '100 Transactions',  file: '/samples/sample_100_transactions.csv',   desc: 'Small dataset – quick demo' },
  { label: '1,000 Transactions', file: '/samples/sample_1000_transactions.csv',  desc: 'Medium dataset – mixed patterns' },
  { label: '10,000 Transactions', file: '/samples/sample_10000_transactions.csv', desc: 'Large dataset – stress test' },
];

function UploadCard({ loading, data, error, onUpload, onFileSelect }) {
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [loadingSample, setLoadingSample] = useState(null);

  const handleUpload = () => {
    const file = selectedFile || fileInputRef.current?.files?.[0];
    if (!file) return;
    onUpload(file);
  };

  const handleFileChange = () => {
    const file = fileInputRef.current?.files?.[0];
    setSelectedFile(file || null);
    if (file && onFileSelect) onFileSelect(file);
  };

  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && file.name.endsWith('.csv')) {
      setSelectedFile(file);
      onUpload(file);
    }
  }, [onUpload]);

  const handleSampleSelect = useCallback(async (sample) => {
    if (loading || loadingSample) return;
    setLoadingSample(sample.label);
    try {
      const response = await fetch(sample.file);
      const blob = await response.blob();
      const fileName = sample.file.split('/').pop();
      const file = new File([blob], fileName, { type: 'text/csv' });
      setSelectedFile(file);
      onUpload(file);
    } catch {
    } finally {
      setLoadingSample(null);
    }
  }, [loading, loadingSample, onUpload]);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 w-full max-w-xl mx-auto flex flex-col">
      <h2 className="text-lg font-semibold text-slate-800 mb-1">
        Upload Transaction CSV
      </h2>

      {!loading && !data && !error && (
        <p className="text-sm text-slate-400 mb-4">
          Drag & drop, browse, or try a sample dataset
        </p>
      )}

      {loading && (
        <p className="text-sm text-blue-500 mb-4 flex items-center gap-2">
          <svg
            className="animate-spin h-4 w-4 text-blue-500"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Analyzing transactions…
        </p>
      )}

      {!loading && data?.success && (
        <p className="text-sm text-green-600 mb-4 font-medium flex items-center gap-1.5">
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          Analysis complete
        </p>
      )}

      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-all ${
          dragActive
            ? 'border-blue-400 bg-blue-50/60'
            : 'border-slate-200 bg-slate-50/50 hover:border-slate-300 hover:bg-slate-50'
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className={`h-8 w-8 ${dragActive ? 'text-blue-400' : 'text-slate-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <p className="text-sm text-slate-500">
          {selectedFile
            ? <span className="font-medium text-slate-700">{selectedFile.name}</span>
            : 'Drop CSV here or click to browse'}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
          Or try a sample dataset
        </p>
        <div className="flex gap-2">
          {SAMPLE_DATASETS.map((sample) => (
            <button
              key={sample.label}
              onClick={() => handleSampleSelect(sample)}
              disabled={loading || !!loadingSample}
              title={sample.desc}
              className="flex-1 py-2 px-2 rounded-lg text-xs font-medium border border-slate-200 bg-slate-50 text-slate-600 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loadingSample === sample.label ? (
                <span className="flex items-center justify-center gap-1">
                  <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Loading…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-1.5">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="8" y1="13" x2="16" y2="13"/>
                    <line x1="8" y1="17" x2="16" y2="17"/>
                  </svg>
                  {sample.label}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={handleUpload}
        disabled={loading || (!selectedFile && !fileInputRef.current?.files?.[0])}
        className="mt-4 w-full py-2.5 px-4 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg
              className="animate-spin h-5 w-5 text-white"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Processing…
          </span>
        ) : (
          'Upload & Analyze'
        )}
      </button>

      {error && (
        <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-100 text-red-700 text-sm">
          {error}
        </div>
      )}

      {data && data.success && (
        <div className="mt-4 p-4 rounded-lg bg-green-50 border border-green-100 text-green-800 text-sm">
          <p className="font-medium mb-2">{data.message}</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs text-green-700">
            <span>Txns: {data.total_transactions}</span>
            <span>Accounts: {data.total_accounts}</span>
            <span>Cycles: {data.cycles_detected}</span>
            <span>Fan-in: {data.fan_in_detected}</span>
            <span>Fan-out: {data.fan_out_detected}</span>
            <span>Mules: {data.shell_chains_detected}</span>
            <span>Suspicious: {data.suspicious_accounts_count}</span>
            <span>Rings: {data.fraud_rings_count}</span>
            <span>Clusters: {data.fraud_clusters_count}</span>
            <span>Time: {data.processing_time_seconds}s</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default UploadCard;
