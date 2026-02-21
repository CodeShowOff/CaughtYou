/**
 * Centralized, environment-overridable configuration for all detection
 * thresholds, scoring weights, and tuning knobs.
 *
 * Every value falls back to a sensible default but can be overridden via
 * the corresponding environment variable (see inline comments).
 */

const num = (envKey, fallback) => {
  const v = process.env[envKey];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Config error: env ${envKey}="${v}" is not a finite number`);
  }
  return n;
};

/* ------------------------------------------------------------------ */
/*  Scoring engine                                                     */
/* ------------------------------------------------------------------ */
const scoring = Object.freeze({
  SCORE_CYCLE:    num('SCORE_CYCLE',    40),
  SCORE_FAN_IN:   num('SCORE_FAN_IN',   25),
  SCORE_FAN_OUT:  num('SCORE_FAN_OUT',  25),
  SCORE_SHELL:    num('SCORE_SHELL',    20),
  SCORE_VELOCITY: num('SCORE_VELOCITY', 10),
  SCORE_AMOUNT:   num('SCORE_AMOUNT',   15),

  MIN_SUSPICION_THRESHOLD: num('MIN_SUSPICION_THRESHOLD', 15),

  HIGH_VELOCITY_TX_MIN:         num('HIGH_VELOCITY_TX_MIN',         15),
  HIGH_VELOCITY_DURATION_MAX_H: num('HIGH_VELOCITY_DURATION_MAX_H', 72),
});

/* ------------------------------------------------------------------ */
/*  Smurfing / fan-in / fan-out                                        */
/* ------------------------------------------------------------------ */
const smurfing = Object.freeze({
  SMURFING_THRESHOLD: num('SMURFING_THRESHOLD', 10),
  TIME_WINDOW_HOURS:  num('SMURFING_WINDOW_HOURS', 72),

  /** Minimum active hours before an account can be classified as payroll/merchant */
  LOW_VELOCITY_DURATION_HOURS: num('SMURFING_LOW_VEL_HOURS', 168),  // 7 days (was 720)
  LOW_VELOCITY_RATE:           num('SMURFING_LOW_VEL_RATE',  0.05),

  /** Minimum outgoing edges to consider payroll classification */
  PAYROLL_MIN_OUT_EDGES: num('SMURFING_PAYROLL_MIN_OUT', 10),
  /** Max coefficient of variation for payroll amount regularity */
  PAYROLL_MAX_COV:       num('SMURFING_PAYROLL_MAX_COV', 0.5),

  /** Minimum unique senders for merchant classification */
  MERCHANT_MIN_SENDERS:       num('SMURFING_MERCHANT_MIN_SENDERS', 10),
  /** Max receiver-to-sender ratio for merchant classification */
  MERCHANT_MAX_RECV_RATIO:    num('SMURFING_MERCHANT_MAX_RECV_RATIO', 0.3),

  /** Max CV of per-sender amounts in a fan-in window (0 = disabled) — reduces FP from crowdfunding etc. */
  FANIN_AMOUNT_CV_MAX: num('SMURFING_FANIN_AMOUNT_CV_MAX', 0),
  /** Minimum median amount for a fan-in window to be flagged (0 = disabled) */
  FANIN_MIN_MEDIAN:    num('SMURFING_FANIN_MIN_MEDIAN', 0),
  /** Max CV of per-receiver amounts in a fan-out window (0 = disabled) */
  FANOUT_AMOUNT_CV_MAX: num('SMURFING_FANOUT_AMOUNT_CV_MAX', 0),
  /** Minimum median amount for a fan-out window to be flagged (0 = disabled) */
  FANOUT_MIN_MEDIAN:    num('SMURFING_FANOUT_MIN_MEDIAN', 0),
});

/* ------------------------------------------------------------------ */
/*  Shell / chain detection                                            */
/* ------------------------------------------------------------------ */
const shell = Object.freeze({
  MAX_CHAIN_DEPTH:  num('SHELL_MAX_CHAIN_DEPTH',  5),
  MIN_CHAIN_LENGTH: num('SHELL_MIN_CHAIN_LENGTH', 3),
  SHELL_DEGREE_MIN: num('SHELL_DEGREE_MIN',       2),
  SHELL_DEGREE_MAX: num('SHELL_DEGREE_MAX',       3),
  /** Minimum in/out ratio for shell intermediate (prevents flagging pure sinks/sources) */
  SHELL_MIN_IO_RATIO: num('SHELL_MIN_IO_RATIO', 0.2),
  /** Max coefficient of variation of amounts across chain hops (0 = disabled) */
  SHELL_AMOUNT_CV_MAX: num('SHELL_AMOUNT_CV_MAX', 1.5),
  /** Maximum time window (hours) for all edges in a shell chain (0 = disabled) */
  SHELL_TIME_WINDOW_HOURS: num('SHELL_TIME_WINDOW_HOURS', 168),  // 7 days
  /** Max |sum_in - sum_out| / max(sum_in, sum_out) for shell intermediates (0 = disabled) */
  SHELL_FLOW_TOLERANCE: num('SHELL_FLOW_TOLERANCE', 0),
});

/* ------------------------------------------------------------------ */
/*  Cycle detection                                                    */
/* ------------------------------------------------------------------ */
const cycle = Object.freeze({
  MAX_CYCLE_LENGTH: num('MAX_CYCLE_LENGTH', 5),
  MAX_CYCLES:       num('MAX_CYCLES',       10000),
  MIN_CYCLE_LENGTH: num('MIN_CYCLE_LENGTH', 3),

  /** Maximum time window (hours) for all edges in a cycle to be considered suspicious */
  CYCLE_TIME_WINDOW_HOURS: num('CYCLE_TIME_WINDOW_HOURS', 72),
  /** Maximum coefficient of variation of amounts within a cycle (0 = identical amounts) */
  CYCLE_AMOUNT_CV_MAX:     num('CYCLE_AMOUNT_CV_MAX', 1.5),
  /** Minimum mean amount for a cycle to be flagged */
  CYCLE_AMOUNT_MIN:        num('CYCLE_AMOUNT_MIN', 0),
  /** Minimum flow ratio: min(amounts)/max(amounts) — enforces value conservation (0 = disabled) */
  CYCLE_FLOW_RATIO_MIN:    num('CYCLE_FLOW_RATIO_MIN', 0),
});

module.exports = { scoring, smurfing, shell, cycle };
