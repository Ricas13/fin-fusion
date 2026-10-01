'use strict';

function bool(value) {
  return value === true || ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());
}

function text(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function integer(value, min, max, label) {
  const raw = String(value ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < min || parsed > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return parsed;
}

function moneyMinor(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error('Enter a valid non-negative price with no more than two decimal places.');
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) {
    throw new Error('Price must be between 0 and 100,000.');
  }
  return Math.round(parsed * 100);
}

function planCode(value) {
  const code = text(value, 50).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,49}$/.test(code)) {
    throw new Error('Code must be 2–50 characters using lowercase letters, numbers and hyphens.');
  }
  return code;
}

function uniqueTextValues(value, { maxItemLength = 200, maxItems = 500, split = false } = {}) {
  const raw = split
    ? String(value || '').split(/[\n,]/)
    : (Array.isArray(value) ? value : [value]);
  return [...new Set(raw.map(item => text(item, maxItemLength)).filter(Boolean))].slice(0, maxItems);
}

function enumValue(value, allowed, fallback) {
  const accepted = allowed instanceof Set ? allowed.has(value) : Array.isArray(allowed) && allowed.includes(value);
  return accepted ? value : fallback;
}

module.exports = {
  bool,
  text,
  integer,
  moneyMinor,
  planCode,
  uniqueTextValues,
  enumValue
};
