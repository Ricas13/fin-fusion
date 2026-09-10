'use strict';

const reconciliationLock = require('../jellyfin/reconciliation-lock');

const LOCK_TIMEOUT_MS = 30000;
const LOCK_POLL_MS = 100;

function key(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Stremio operation lock key is required.');
  return `captainfin:stremio:${text}`;
}

async function withLock(value, fn, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  if (typeof fn !== 'function') throw new Error('Stremio operation lock requires a callback.');
  const lockKey = key(value);
  try {
    // Stremio operations must remain serialized across web/worker processes while
    // provider calls are in flight, so a session advisory lock is still the
    // correctness primitive. Reuse the dedicated, process-bounded reconciliation
    // lock connection budget instead of checking a client out of the main app
    // pool for the entire external operation. This keeps slow media servers from
    // starving unrelated application queries while preserving cross-process
    // exclusion and the automation role's explicit connection ceiling.
    return await reconciliationLock.withDatabaseLock(lockKey, fn, { timeoutMs });
  } catch (error) {
    if (error?.code === 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT') {
      error.code = 'STREMIO_OPERATION_LOCK_TIMEOUT';
      error.message = 'Another Stremio operation for this resource is still running. Try again shortly.';
    }
    throw error;
  }
}

module.exports = { LOCK_TIMEOUT_MS, LOCK_POLL_MS, key, withLock };
