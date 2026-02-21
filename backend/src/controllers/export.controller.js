const { buildExportJSON } = require('../services/json.export.service');
const { errorResponse } = require('../utils/response.util');

const handleExportJSON = (req, res) => {
  try {
    const graphContext = req.app.locals.graphContext;

    if (!graphContext) {
      return errorResponse(
        res,
        'No analysis data available. Please upload a CSV file first.',
        400
      );
    }

    const exportData = buildExportJSON(graphContext);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="financial_forensics_output.json"'
    );

    let jsonStr = JSON.stringify(exportData, null, 2);
    jsonStr = jsonStr.replace(
      /("suspicion_score"\s*:\s*)(-?\d+(?:\.\d+)?)/g,
      (_, prefix, numStr) => prefix + Number(numStr).toFixed(1)
    );
    jsonStr = jsonStr.replace(
      /("risk_score"\s*:\s*)(-?\d+(?:\.\d+)?)/g,
      (_, prefix, numStr) => prefix + Number(numStr).toFixed(1)
    );
    jsonStr = jsonStr.replace(
      /("processing_time_seconds"\s*:\s*)(-?\d+(?:\.\d+)?)/g,
      (_, prefix, numStr) => prefix + Number(numStr).toFixed(1)
    );
    return res.status(200).send(jsonStr);
  } catch (err) {
    return errorResponse(res, err.message, 500);
  }
};

module.exports = { handleExportJSON };
