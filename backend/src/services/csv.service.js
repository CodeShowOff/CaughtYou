const { Readable } = require('stream');
const csvParser = require('csv-parser');
const { REQUIRED_CSV_HEADERS } = require('../config/constants');
const { createTransaction } = require('../models/transaction.model');

// Configurable safety limits
const MAX_CSV_SIZE_BYTES = Number(process.env.MAX_CSV_SIZE_BYTES) || 50 * 1024 * 1024; // 50 MB
const MAX_CSV_ROWS = Number(process.env.MAX_CSV_ROWS) || 500_000;

const parseCSV = (buffer) => {
  return new Promise((resolve, reject) => {
    // Coerce string input to Buffer for consistent handling
    if (!Buffer.isBuffer(buffer) && typeof buffer === 'string') {
      buffer = Buffer.from(buffer);
    }

    // Guard: reject files that are too large
    if (buffer.length > MAX_CSV_SIZE_BYTES) {
      return reject(
        new Error(`CSV file too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Maximum allowed: ${(MAX_CSV_SIZE_BYTES / 1024 / 1024).toFixed(0)} MB`)
      );
    }

    const transactions = [];
    let headersValidated = false;
    let rowIndex = 0;
    let destroyed = false;

    // Strip BOM from buffer if present (avoids duplicate handling downstream)
    let start = 0;
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      start = 3; // UTF-8 BOM
    }
    const cleanBuffer = start > 0 ? buffer.subarray(start) : buffer;

    // Stream directly from buffer — avoids a full Buffer→String copy that
    // would double memory for large CSVs. Readable.from([buffer]) emits one
    // chunk (not character-by-character) which csv-parser handles correctly.
    const stream = Readable.from([cleanBuffer]);

    stream
      .pipe(csvParser({
        mapHeaders: ({ header }) => header.trim(),
        strict: true,     // reject rows with wrong column count
        escape: '"',       // proper CSV escape handling
      }))
      .on('headers', (headers) => {
        // BOM already stripped from buffer above; trim whitespace only
        const cleanHeaders = headers.map((h) => h.trim());

        // Case-insensitive header matching
        const lowerCleanHeaders = cleanHeaders.map((h) => h.toLowerCase());
        const missing = REQUIRED_CSV_HEADERS.filter(
          (required) => !lowerCleanHeaders.includes(required.toLowerCase())
        );

        if (missing.length > 0) {
          destroyed = true;
          const err = new Error(
            `Invalid CSV: missing required column(s): ${missing.join(', ')}`
          );
          // Reject before destroy to avoid potential double-rejection from
          // the 'error' event that stream.destroy() may synchronously emit.
          reject(err);
          stream.destroy();
          return;
        }
        headersValidated = true;
      })
      .on('data', (row) => {
        if (!headersValidated || destroyed) return;

        rowIndex += 1;

        // Guard: reject files with too many rows
        if (rowIndex > MAX_CSV_ROWS) {
          destroyed = true;
          const err = new Error(`CSV exceeds maximum allowed rows (${MAX_CSV_ROWS})`);
          reject(err);
          stream.destroy();
          return;
        }

        try {
          // rowIndex is 1-based (incremented above) matching user-facing row numbers
          const transaction = createTransaction(row, rowIndex);
          transactions.push(transaction);
        } catch (err) {
          destroyed = true;
          reject(err);
          stream.destroy();
        }
      })
      .on('end', () => {
        if (destroyed) return;
        if (transactions.length === 0) {
          reject(new Error('CSV file contains no data rows'));
          return;
        }
        resolve(transactions);
      })
      .on('error', (err) => {
        if (!destroyed) reject(err);
      });
  });
};

module.exports = { parseCSV };
