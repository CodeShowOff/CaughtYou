const { Router } = require('express');
const multer = require('multer');
const { handleUpload } = require('../controllers/upload.controller');

const router = Router();

const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  if (
    file.mimetype === 'text/csv' ||
    file.originalname.toLowerCase().endsWith('.csv')
  ) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV files are allowed'), false);
  }
};

const MAX_CSV_SIZE_BYTES = Number(process.env.MAX_CSV_SIZE_BYTES) || 50 * 1024 * 1024; // 50 MB — matches csv.service.js
const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_CSV_SIZE_BYTES } });

router.post('/upload', upload.single('file'), handleUpload);

module.exports = router;
