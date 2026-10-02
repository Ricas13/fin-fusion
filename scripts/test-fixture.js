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

async function fixtureCustomer(client, overrides = {}) {
  const displayName = overrides.displayName || unique('Fixture customer');
  const email = overrides.email || `${unique('fixture')}@example.invalid`;
  return (await client.query(
    `INSERT INTO customers(display_name,email,registration_source) VALUES($1,$2,$3) RETURNING *`,
    [displayName, email, overrides.registrationSource || 'public']
  )).rows[0];
}

async function fixturePlan(client, overrides = {}) {
  const code = overrides.code || unique('fixture-plan');
  const name = overrides.name || 'Fixture Plan';
  return (await client.query(`
    INSERT INTO plans(
      code,name,audience,service_type,billing_interval,duration_days,
      price_minor,currency,streams,active,visible,sort_order
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,TRUE,$10)
    RETURNING *
  `, [
    code,
    name,
    overrides.audience || 'direct',
    overrides.serviceType || 'jellyfin',
    overrides.billingInterval || 'month',
    Number(overrides.durationDays ?? 30),
    Number(overrides.priceMinor ?? 1000),
    overrides.currency || 'GBP',
    Number(overrides.streams ?? 1),
    Number(overrides.sortOrder ?? 999)
  ])).rows[0];
}

async function fixtureSubscription(client, { customerId, planId, ...overrides } = {}) {
  if (!customerId || !planId) throw new Error('fixtureSubscription requires customerId and planId');
  return (await client.query(`
    INSERT INTO subscriptions(
      customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,
      provider_subscription_id,service_type_snapshot
    ) VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()),COALESCE($7::timestamptz,NOW()+INTERVAL '30 days'),$8,$9)
    RETURNING *
  `, [
    customerId,
    planId,
    overrides.status || 'active',
    overrides.source || 'admin_grant',
    overrides.billingMode || 'manual',
    overrides.startsAt || null,
    overrides.currentPeriodEnd || null,
    overrides.providerSubscriptionId || null,
    overrides.serviceType || 'jellyfin'
  ])).rows[0];
}

module.exports = {
  runDbSmoke,
  withRollback,
  withTimezones,
  withEnv,
  unique,
  deferred,
  barrier,
  installModuleMock,
  fixtureCustomer,
  fixturePlan,
  fixtureSubscription
};
