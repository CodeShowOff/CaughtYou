const Decimal = require('decimal.js');

// Maximum allowed length for string fields to prevent abuse
const MAX_ID_LENGTH = 128;
const MAX_CURRENCY_LENGTH = 10;

// Reject control characters and other suspicious patterns in IDs
const UNSAFE_CHARS = /[\x00-\x1f\x7f]/;

const validateId = (value, fieldName, index) => {
  if (!value || !value.trim()) {
    throw new Error(`Row ${index}: missing or empty ${fieldName}`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_ID_LENGTH) {
    throw new Error(`Row ${index}: ${fieldName} exceeds maximum length (${MAX_ID_LENGTH} chars)`);
  }
  if (UNSAFE_CHARS.test(trimmed)) {
    throw new Error(`Row ${index}: ${fieldName} contains invalid control characters`);
  }
  return trimmed;
};

const createTransaction = (row, index) => {
  const { transaction_id, sender_id, receiver_id, amount, timestamp, currency } = row;

  const cleanTxId = validateId(transaction_id, 'transaction_id', index);
  const cleanSenderId = validateId(sender_id, 'sender_id', index);
  const cleanReceiverId = validateId(receiver_id, 'receiver_id', index);
  if (amount === undefined || amount === null || amount === '') {
    throw new Error(`Row ${index}: missing amount`);
  }
  if (!timestamp || !timestamp.trim()) {
    throw new Error(`Row ${index}: missing or empty timestamp`);
  }

  // Use Decimal for precise monetary arithmetic
  let amountDecimal;
  try {
    amountDecimal = new Decimal(amount);
  } catch {
    throw new Error(`Row ${index}: amount "${amount}" is not a valid number`);
  }
  if (!amountDecimal.isFinite()) {
    throw new Error(`Row ${index}: amount "${amount}" is not a valid number`);
  }
  if (amountDecimal.lte(0)) {
    throw new Error(`Row ${index}: amount must be greater than 0, got ${amountDecimal.toString()}`);
  }

  const parsedAmount = amountDecimal.toNumber();

  const trimmedTimestamp = timestamp.trim();
  const tsMatch = trimmedTimestamp.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/);
  if (!tsMatch) {
    throw new Error(`Row ${index}: timestamp "${timestamp}" does not match YYYY-MM-DD HH:MM:SS`);
  }
  const [, year, month, day, hour, minute, second] = tsMatch;
  const parsedTimestamp = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ));
  if (Number.isNaN(parsedTimestamp.getTime())) {
    throw new Error(`Row ${index}: timestamp "${timestamp}" is not a valid date`);
  }

  // Normalise currency (default to USD when column absent)
  const rawCurrency = (currency && currency.trim()) ? currency.trim().toUpperCase() : 'USD';
  if (rawCurrency.length > MAX_CURRENCY_LENGTH) {
    throw new Error(`Row ${index}: currency code too long`);
  }
  const parsedCurrency = rawCurrency;

  return {
    transaction_id: cleanTxId,
    sender_id: cleanSenderId,
    receiver_id: cleanReceiverId,
    amount: parsedAmount,
    amountDecimal,
    currency: parsedCurrency,
    timestamp: parsedTimestamp,
  };
};

module.exports = { createTransaction };
