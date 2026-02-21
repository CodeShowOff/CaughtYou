import axios from 'axios';

const axiosClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  headers: {
    'Accept': 'application/json',
  },
});

/**
 * Download the fraud report JSON as a blob from the backend.
 * @returns {Promise<Blob>}
 */
export async function downloadJSONExport() {
  const response = await axiosClient.get('/export-json', {
    responseType: 'blob',
  });
  return response.data;
}

export default axiosClient;
