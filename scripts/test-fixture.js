'use strict';

const crypto = require('crypto');
const { skipIfNoDatabase } = require('./smoke-db');
const { getPool } = require('../src/db');

async function runDbSmoke(label, fn) {
  if (skipIfNoDatabase(label)) return;
  try {
    await fn();
    console.log(`${label}: ok`);
  } finally {
    await getPool().end();
  }
}

async function withRollback(fn) {
  const client = await getPool().connect();
  await client.query('BEGIN');
  try {
    return await fn(client);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

async function withTimezones(zones, fn) {
  const original = process.env.TZ;
  try {
    for (const zone of zones) {
      process.env.TZ = zone;
      await fn(zone);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

async function withEnv(overrides, fn) {
  const prior = new Map();
  for (const [key, value] of Object.entries(overrides || {})) {
    prior.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prior.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function unique(label = 'fixture') {
  return `${label}-${crypto.randomBytes(8).toString('hex')}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function barrier(parties = 2) {
  const expected = Math.max(1, Number(parties) || 1);
  let arrived = 0;
  let gate = deferred();
  return async function wait() {
    arrived += 1;
    if (arrived >= expected) gate.resolve();
    await gate.promise;
  };
}

function installModuleMock(moduleName, replacement) {
  const resolved = require.resolve(moduleName);
  require(resolved);
  const prior = require.cache[resolved].exports;
  require.cache[resolved].exports = replacement;
  return () => {
    if (require.cache[resolved]) require.cache[resolved].exports = prior;
  };
}

module.exports = {
  runDbSmoke,
  withRollback,
  withTimezones,
  withEnv,
  unique,
  deferred,
  barrier,
  installModuleMock
};
