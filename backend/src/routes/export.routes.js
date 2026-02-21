const { Router } = require('express');
const { handleExportJSON } = require('../controllers/export.controller');

const router = Router();

router.get('/export-json', handleExportJSON);

module.exports = router;
