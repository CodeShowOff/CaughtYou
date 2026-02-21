const { parseCSV } = require('../services/csv.service');
const { buildGraph } = require('../services/graph.service');
const { buildDegreeMap, computeVelocityMetrics } = require('../services/graph.analytics.service');
const { buildTemporalIndex } = require('../services/temporal.index.service');
const { runCycleDetection } = require('../services/cycle.detection.service');
const { runSmurfingDetection } = require('../services/smurfing.detection.service');
const { runShellDetection } = require('../services/shell.detection.service');
const { runScoringEngine } = require('../services/scoring.engine.service');
const { buildFraudClusters } = require('../services/graph.cluster.service');
const { successResponse, errorResponse } = require('../utils/response.util');

const handleUpload = async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, 'No file uploaded. Please attach a CSV file.', 400);
    }

    const startTime = Date.now();

    const transactions = await parseCSV(req.file.buffer);
    const parseEndTime = Date.now();

    const { nodes, outgoingEdges, incomingEdges, outgoingMap, incomingMap, globalTransactionList } =
      buildGraph(transactions);
    const graphEndTime = Date.now();

    const degreeMap = buildDegreeMap(outgoingEdges, incomingEdges);

    // Use deduped globalTransactionList (not raw transactions) for downstream analysis
    const { index: temporalIndex, inIndex: temporalInIndex, outIndex: temporalOutIndex } = buildTemporalIndex(globalTransactionList);

    const velocityMetrics = computeVelocityMetrics(temporalIndex);
    const analyticsEndTime = Date.now();

    const fraudRings = runCycleDetection({ outgoingEdges, outgoingMap, degreeMap });
    const cycleEndTime = Date.now();

    const graphContext = {
      nodes,
      outgoingEdges,
      incomingEdges,
      outgoingMap,
      incomingMap,
      degreeMap,
      temporalIndex,
      temporalInIndex,
      temporalOutIndex,
      velocityMetrics,
      globalTransactionList,
      fraudRings,
    };

    const { fanInAccounts, fanOutAccounts } = runSmurfingDetection(graphContext);
    const smurfingEndTime = Date.now();

    const { shellChains } = runShellDetection(graphContext);
    const shellEndTime = Date.now();

    const { suspiciousAccounts, unifiedFraudRings } = runScoringEngine(graphContext);
    const scoringEndTime = Date.now();

    const fraudClusters = buildFraudClusters(graphContext);
    const clusterEndTime = Date.now();

    const endTime = Date.now();
    const processingTimeSeconds = parseFloat(
      ((endTime - startTime) / 1000).toFixed(1)
    );
    graphContext.processingTimeSeconds = processingTimeSeconds;
    graphContext.processingStartTime = startTime;
    graphContext.processingEndTime = endTime;

    // Structured logging: counts and per-stage latencies
    console.log(`[pipeline] Input: ${transactions.length} raw txns → ${globalTransactionList.length} deduped (${transactions.length - globalTransactionList.length} dupes removed)`);
    console.log(`[pipeline] Accounts: ${nodes.size} | Cycles: ${fraudRings.length} | Fan-in: ${fanInAccounts.size} | Fan-out: ${fanOutAccounts.size} | Shells: ${shellChains.length} | Suspicious: ${suspiciousAccounts.length}`);
    console.log(`[pipeline] Latency: parse=${parseEndTime - startTime}ms graph=${graphEndTime - parseEndTime}ms analytics=${analyticsEndTime - graphEndTime}ms cycles=${cycleEndTime - analyticsEndTime}ms smurfing=${smurfingEndTime - cycleEndTime}ms shell=${shellEndTime - smurfingEndTime}ms scoring=${scoringEndTime - shellEndTime}ms clusters=${clusterEndTime - scoringEndTime}ms total=${endTime - startTime}ms`);

    req.app.locals.graphContext = graphContext;

    // Free large intermediate structures that aren't needed for the response
    // (graphContext retains them for the export endpoint; these are local refs)
    // The adjacency maps are retained in graphContext for potential export use.

    const edgeSet = new Set();
    const allEdges = [];
    for (const tx of globalTransactionList) {
      const key = `${tx.sender_id}_${tx.receiver_id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        allEdges.push({
          sender_id: tx.sender_id,
          receiver_id: tx.receiver_id,
        });
      }
    }

    const responseData = {
      total_transactions: transactions.length,
      total_accounts: nodes.size,
      cycles_detected: fraudRings.length,
      fan_in_detected: fanInAccounts.size,
      fan_out_detected: fanOutAccounts.size,
      shell_chains_detected: shellChains.length,
      suspicious_accounts_count: suspiciousAccounts.length,
      fraud_rings_count: unifiedFraudRings.length,
      fraud_clusters_count: fraudClusters.length,
      processing_time_seconds: processingTimeSeconds,
      message: 'Scoring engine complete.',
      graph_data: {
        nodes: [...nodes.keys()],
        edges: allEdges,
        suspicious_accounts: suspiciousAccounts,
        fraud_rings: unifiedFraudRings,
        fraud_clusters: fraudClusters,
      },
    };

    return successResponse(res, responseData);
  } catch (err) {
    const status = err.message.startsWith('Invalid CSV') ||
                   err.message.startsWith('Row ') ||
                   err.message.startsWith('CSV file contains') ||
                   err.message.startsWith('CSV file too large') ||
                   err.message.startsWith('CSV exceeds')
      ? 400
      : 500;

    return errorResponse(res, err.message, status);
  }
};

module.exports = { handleUpload };
