'use strict';

const { getPool } = require('../db');

const LOCK_TIMEOUT_MS = 30000;
const LOCK_POLL_MS = 100;

function key(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Stremio operation lock key is required.');
  return `captainfin:stremio:${text}`;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withLock(value, fn, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  if (typeof fn !== 'function') throw new Error('Stremio operation lock requires a callback.');
  const lockKey = key(value);
  const client = await getPool().connect();
  const deadline = Date.now() + Math.max(1000, Math.min(120000, Number(timeoutMs) || LOCK_TIMEOUT_MS));
  let locked = false;
  try {
    do {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockKey]);
      if (result.rows[0]?.locked === true) { locked = true; break; }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    if (!locked) {
      const error = new Error('Another Stremio operation for this resource is still running. Try again shortly.');
      error.code = 'STREMIO_OPERATION_LOCK_TIMEOUT';
      throw error;
    }
    return await fn();
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]).catch(() => {});
    client.release();
  }
}

module.exports = { LOCK_TIMEOUT_MS, LOCK_POLL_MS, key, withLock };
