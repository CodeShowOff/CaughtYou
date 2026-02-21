const express = require('express');
const cors = require('cors');
const { PORT } = require('./config/constants');
const uploadRoutes = require('./routes/upload.routes');
const exportRoutes = require('./routes/export.routes');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', uploadRoutes);
app.use('/api', exportRoutes);

app.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'CaughtYou backend is running.' });
});

app.use((err, _req, res, _next) => {
  if (err.message === 'Only CSV files are allowed') {
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, error: `File too large. Maximum allowed size: ${Math.round((Number(process.env.MAX_CSV_SIZE_BYTES) || 50 * 1024 * 1024) / (1024 * 1024))} MB` });
  }
  return res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`CaughtYou backend listening on port ${PORT}`);
});

module.exports = app;
