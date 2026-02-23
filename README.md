# CaughtYou

A graph-based financial crime detection engine that ingests CSV transaction data, constructs a directed transaction graph, and runs multiple fraud-detection algorithms to identify money muling networks, layering schemes, and smurfing patterns.

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [API Reference](#api-reference)
- [CSV Format](#csv-format)
- [Detection Algorithms](#detection-algorithms)
- [Scoring Engine](#scoring-engine)
- [Output Format](#output-format)
- [Configuration](#configuration)

---

## Overview

CaughtYou accepts a CSV file of financial transactions, builds a directed graph where nodes are accounts and edges are transactions, and runs four detection passes:

1. **Cycle Detection** — circular fund routing (A → B → C → A)
2. **Smurfing / Fan-In / Fan-Out Detection** — aggregation and dispersal patterns
3. **Shell Chain Detection** — money layered through intermediate shell accounts
4. **Velocity Analysis** — accounts with abnormally high transaction rates

Each flagged account receives a composite suspicion score (0–100). Related suspicious accounts are grouped into named fraud rings with stable IDs.

Results are returned as JSON and can be visualized interactively in the browser via Sigma.js.

---

## Tech Stack

### Backend

| | |
|---|---|
| Runtime | Node.js (CommonJS) |
| Framework | Express 4 |
| File Upload | Multer (memory storage) |
| CSV Parsing | csv-parser |
| Precise Arithmetic | decimal.js |

### Frontend

| | |
|---|---|
| UI Framework | React 19 |
| Build Tool | Vite 7 |
| Styling | Tailwind CSS 4 |
| HTTP Client | axios |
| Graph Library | graphology + Sigma.js 3 |
| Graph Layout | ForceAtlas2 |

---

## Project Structure

```
CaughtYou/
├── backend/
│   └── src/
│       ├── server.js                      # Express entry point (port 5000)
│       ├── config/
│       │   ├── constants.js               # All tunable thresholds & limits
│       │   └── detectors.js               # Detector enable/disable flags
│       ├── controllers/
│       │   ├── upload.controller.js       # Orchestrates the detection pipeline
│       │   └── export.controller.js       # Serves cached result as JSON download
│       ├── models/
│       │   └── transaction.model.js       # Row validation & normalization
│       ├── routes/
│       │   ├── upload.routes.js           # POST /api/upload
│       │   └── export.routes.js           # GET  /api/export-json
│       ├── services/
│       │   ├── graph.service.js           # Graph construction
│       │   ├── cycle.detection.service.js
│       │   ├── smurfing.detection.service.js
│       │   ├── shell.detection.service.js
│       │   ├── graph.analytics.service.js # Velocity analysis
│       │   ├── scoring.engine.service.js  # Score aggregation & ring assignment
│       │   ├── graph.cluster.service.js   # Community/cluster helpers
│       │   ├── temporal.index.service.js  # Time-window indexing
│       │   ├── csv.service.js             # CSV stream parsing
│       │   └── json.export.service.js     # Output serialization
│       └── utils/
│           ├── edge.selection.util.js
│           └── response.util.js
└── frontend/
    └── src/
        ├── App.jsx
        ├── pages/Home.jsx
        ├── components/
        │   ├── UploadCard.jsx             # Drag-and-drop CSV upload
        │   ├── CsvPreview.jsx             # Preview first 200 rows
        │   ├── GraphContainer.jsx         # Sigma.js interactive graph
        │   ├── AccountDetailsPanel.jsx    # Slide-in node detail panel
        │   └── SummaryPanel.jsx           # Fraud ring summary table
        ├── hooks/useUpload.js
        └── api/axiosClient.js
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Backend

```bash
cd backend
npm install
npm start
```

The server starts on `http://localhost:5000`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The dev server starts on `http://localhost:5173` and proxies API calls to the backend.

### Running Both Together

Open two terminals and run the backend and frontend commands above simultaneously.

---

## API Reference

### `POST /api/upload`

Upload a CSV file for analysis.

- **Content-Type:** `multipart/form-data`
- **Field name:** `file`
- **Accepted:** `.csv` files up to 50 MB

**Response:**
```json
{
  "suspicious_accounts": [...],
  "fraud_rings": [...],
  "summary": { ... },
  "graph": { "nodes": [...], "edges": [...] }
}
```

### `GET /api/export-json`

Download the most recent analysis result as a `.json` file.

### `GET /`

Health check — returns `{ "status": "ok" }`.

---

## CSV Format

| Column | Type | Required | Notes |
|---|---|---|---|
| `transaction_id` | string | yes | Unique, ≤ 128 chars |
| `sender_id` | string | yes | Source account |
| `receiver_id` | string | yes | Destination account |
| `amount` | number | yes | Must be finite and positive |
| `timestamp` | string | yes | `YYYY-MM-DD HH:MM:SS` or ISO-8601 |
| `currency` | string | no | Defaults to `USD` |

Sample files are available in `frontend/public/samples/`.

**Validation rules:**
- Amounts above `1,000,000,000,000` are quarantined
- Timestamps older than 10 years or more than 1 day in the future are rejected
- Rows failing validation are skipped; the pipeline continues on valid rows

---

## Detection Algorithms

### 1. Cycle Detection

Finds circular fund flows (e.g., A → B → C → A) using DFS-based cycle enumeration.

| Parameter | Default |
|---|---|
| Cycle length range | 3–5 hops |
| Time window | 72 hours |
| Max backward time jumps | 1 |
| Amount coefficient of variation cap | 1.5 |
| Max cycles enumerated | 10,000 |

Cycles are canonicalized to avoid counting the same ring multiple times.

### 2. Smurfing / Fan-In / Fan-Out Detection

Detects aggregation (many-to-one) and dispersal (one-to-many) patterns within a sliding time window.

| Parameter | Default |
|---|---|
| Threshold (unique counterparties) | ≥ 10 within 72 hours |
| Payroll exclusion | CoV < 0.5 OR regular cadence |
| Merchant exclusion | receiver/sender ratio ≤ 0.3 OR ≥ 30% repeated amount |
| Benign name prefixes excluded | `PAYROLL*`, `MERCHANT*`, `SALARY*`, `VENDOR*`, `SUPPLIER*`, `GOV*`, `TREASURY*`, `UTILITY*`, `INSURANCE*` |

### 3. Shell Chain Detection

Identifies layering through intermediate shell accounts — accounts that receive and immediately forward funds with minimal other activity.

| Parameter | Default |
|---|---|
| Chain length | 3–5 hops |
| Shell account degree | 2–3 total connections |
| Time window | 168 hours (7 days) |
| Amount coefficient of variation cap | 1.5 |

### 4. Velocity Analysis

Flags accounts with abnormally high transaction rates.

| Parameter | Default |
|---|---|
| High velocity threshold | ≥ 15 transactions within 72 hours |
| Batch mode detection | Suppresses signals when ≥ 80% of timestamps are identical |

Batch mode prevents false positives when analyzing datasets that were imported as a batch rather than representing real-time activity.

---

## Scoring Engine

Each account receives a composite suspicion score from 0 to 100:

| Signal | Points |
|---|---|
| Cycle involvement | +40 |
| Fan-in pattern | +25 |
| Fan-out pattern | +25 |
| Shell chain membership | +20 |
| High velocity | +10 |
| High amount (above P90) | +15 |

- **Minimum to flag:** 15 points
- **Confidence levels:** `low` / `medium` / `high` based on number of distinct detectors triggered
- Amount scoring normalizes against the 90th percentile of all account totals
- Fraud ring IDs are stable SHA-256 hashes of sorted member accounts + pattern type, formatted as `RING_<16-char-hex>`

---

## Output Format

```json
{
  "suspicious_accounts": [
    {
      "account_id": "ACC_001",
      "suspicion_score": 87.5,
      "detected_patterns": ["cycle_length_3", "high_velocity"],
      "ring_id": "RING_3f8a1c2d44e7b901"
    }
  ],
  "fraud_rings": [
    {
      "ring_id": "RING_3f8a1c2d44e7b901",
      "member_accounts": ["ACC_001", "ACC_042", "ACC_107"],
      "pattern_type": "cycle",
      "risk_score": 95.3
    }
  ],
  "summary": {
    "total_accounts_analyzed": 500,
    "suspicious_accounts_flagged": 15,
    "fraud_rings_detected": 4,
    "processing_time_seconds": 2.3
  }
}
```

---

## Configuration

All thresholds and scoring weights are overridable via environment variables. Create a `.env` file in `backend/` to tune the engine without changing source code.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | Backend listen port |
| `MAX_CSV_SIZE_BYTES` | `52428800` | Upload size limit (50 MB) |
| `MIN_CYCLE_LENGTH` | `3` | Shortest cycle to detect |
| `MAX_CYCLE_LENGTH` | `5` | Longest cycle to detect |
| `CYCLE_TIME_WINDOW_HOURS` | `72` | Cycle temporal filter |
| `MAX_CYCLES` | `10000` | Cycle enumeration cap |
| `SMURFING_THRESHOLD` | `10` | Fan-in/fan-out counterparty count |
| `TIME_WINDOW_HOURS` | `72` | Smurfing time window |
| `MIN_CHAIN_LENGTH` | `3` | Shortest shell chain |
| `MAX_CHAIN_DEPTH` | `5` | Deepest shell chain |
| `SHELL_TIME_WINDOW_HOURS` | `168` | Shell chain time window |
| `HIGH_VELOCITY_TX_MIN` | `15` | Transactions to trigger velocity flag |
| `HIGH_VELOCITY_DURATION_MAX_H` | `72` | Window for velocity check |
| `MIN_SUSPICION_THRESHOLD` | `15` | Minimum score to flag an account |
| `SCORE_CYCLE` | `40` | Points for cycle involvement |
| `SCORE_FAN_IN` | `25` | Points for fan-in pattern |
| `SCORE_FAN_OUT` | `25` | Points for fan-out pattern |
| `SCORE_SHELL` | `20` | Points for shell chain membership |
| `SCORE_VELOCITY` | `10` | Points for high velocity |
| `SCORE_AMOUNT` | `15` | Points for high amount |
