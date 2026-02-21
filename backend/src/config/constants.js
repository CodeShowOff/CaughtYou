// Infrastructure & API-level constants.
// Detection thresholds have moved to config/detectors.js and are env-overridable.

const MAX_SUBGRAPH_NODES = 2000;
const MAX_NEIGHBOR_NODES = 500;

const REQUIRED_CSV_HEADERS = [
  'transaction_id',
  'sender_id',
  'receiver_id',
  'amount',
  'timestamp',
];

const PORT = process.env.PORT || 5000;

/** Maximum reasonable transaction amount — amounts above this are quarantined */
const MAX_REASONABLE_AMOUNT = Number(process.env.MAX_REASONABLE_AMOUNT) || 1e12;

/** Timestamp validation window (years into past / days into future) */
const TIMESTAMP_MAX_AGE_YEARS = Number(process.env.TIMESTAMP_MAX_AGE_YEARS) || 10;
const TIMESTAMP_MAX_FUTURE_DAYS = Number(process.env.TIMESTAMP_MAX_FUTURE_DAYS) || 1;

/** Batch-mode detection: if >= this fraction of txns share the same timestamp, disable velocity */
const BATCH_MODE_SAME_TS_RATIO = Number(process.env.BATCH_MODE_SAME_TS_RATIO) || 0.8;
/** Batch-mode detection: if stddev of timestamps (ms) is below this, treat as batch */
const BATCH_MODE_STDDEV_MS = Number(process.env.BATCH_MODE_STDDEV_MS) || 1000;

module.exports = {
  REQUIRED_CSV_HEADERS,
  MAX_SUBGRAPH_NODES,
  MAX_NEIGHBOR_NODES,
  PORT,
  MAX_REASONABLE_AMOUNT,
  TIMESTAMP_MAX_AGE_YEARS,
  TIMESTAMP_MAX_FUTURE_DAYS,
  BATCH_MODE_SAME_TS_RATIO,
  BATCH_MODE_STDDEV_MS,
};
