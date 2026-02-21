import { useState, useCallback } from 'react';
import axiosClient from '../api/axiosClient';

/**
 * Custom hook for uploading CSV files to the backend.
 *
 * Returns:
 *  - loading   : boolean indicating an upload is in progress
 *  - data      : full response payload from the server (or null)
 *  - graphData : graph_data object extracted from response (or null)
 *  - error     : error message string (or null)
 *  - uploadCSV : async function accepting a File object
 */
function useUpload() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [graphData, setGraphData] = useState(null);
  const [error, setError] = useState(null);

  const uploadCSV = useCallback(async (file) => {
    setLoading(true);
    setData(null);
    setGraphData(null);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await axiosClient.post('/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setData(response.data);

      if (response.data?.graph_data) {
        setGraphData(response.data.graph_data);
      }
    } catch (err) {
      const message =
        err.response?.data?.error || err.message || 'Upload failed.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, data, graphData, error, uploadCSV };
}

export default useUpload;
