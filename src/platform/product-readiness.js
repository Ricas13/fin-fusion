'use strict';

const { query } = require('../db');
const stremioFoundation = require('../stremio/foundation');
const stremioRuntimeSettings = require('../stremio/runtime-settings');

function serviceType(plan) {
  const value = String(plan?.service_type || plan?.service_type_snapshot || 'jellyfin').toLowerCase();
  return ['jellyfin', 'stremio', 'bundle'].includes(value) ? value : 'jellyfin';
}

function catalogueState(plan, now = Date.now()) {
  if (plan?.archived_at) return { key: 'archived', label: 'Archived', kind: 'bad', sellable: false };
  if (plan?.effective_from && new Date(plan.effective_from).getTime() > now) return { key: 'scheduled', label: 'Scheduled', kind: 'warn', sellable: false };
  if (plan?.effective_until && new Date(plan.effective_until).getTime() <= now) return { key: 'ended', label: 'Ended', kind: 'bad', sellable: false };
  if (!plan?.active) return { key: 'inactive', label: 'Inactive', kind: 'warn', sellable: false };
  if (!plan?.visible) return { key: 'hidden', label: 'Hidden', kind: 'warn', sellable: false };
  return { key: 'catalogue_ready', label: 'Catalogue ready', kind: 'good', sellable: true };
}

async function stremioContext() {
  await stremioRuntimeSettings.ensureLoaded();
  const checks = await stremioRuntimeSettings.prerequisites();
  return {
    runtimeReady: stremioFoundation.runtimeReady(),
    eligibleServers: checks.eligibleServers,
    readyIndexes: checks.readyIndexes
  };
}

async function context() {
  return { stremio: await stremioContext() };
}

function evaluate(plan, ctx) {
  const catalogue = catalogueState(plan);
  if (!catalogue.sellable) return { ...catalogue, serviceType: serviceType(plan) };

  const delivery = serviceType(plan);
  if (delivery === 'stremio' || delivery === 'bundle') {
    if (!ctx?.stremio?.runtimeReady) return { key: 'runtime_unavailable', label: 'Runtime unavailable', kind: 'bad', sellable: false, serviceType: delivery };
    if (Number(ctx?.stremio?.eligibleServers || 0) < 1) return { key: 'no_delivery_server', label: 'No Stremio server', kind: 'bad', sellable: false, serviceType: delivery };
    if (Number(ctx?.stremio?.readyIndexes || 0) < 1) return { key: 'index_not_ready', label: 'Index not ready', kind: 'warn', sellable: false, serviceType: delivery };
  }

  return { key: 'live', label: 'Live', kind: 'good', sellable: true, serviceType: delivery };
}

async function evaluatePlan(plan, ctx = null) {
  return evaluate(plan, ctx || await context());
}

async function planByCode(code) {
  const value = String(code || '').trim();
  if (!value) return null;
  const result = await query('SELECT * FROM plans WHERE code=$1 LIMIT 1', [value]);
  return result.rows[0] || null;
}

async function assertSellablePlan(plan, ctx = null) {
  if (!plan) throw new Error('This plan is not available for new sale.');
  const readiness = await evaluatePlan(plan, ctx);
  if (!readiness.sellable) {
    const error = new Error(`This plan cannot be sold right now: ${readiness.label}.`);
    error.code = `PLAN_${String(readiness.key || 'UNAVAILABLE').toUpperCase()}`;
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

async function assertSellableCode(code, ctx = null) {
  const plan = await planByCode(code);
  const readiness = await assertSellablePlan(plan, ctx);
  return { plan, readiness };
}

function deliveryLabel(plan) {
  return ({ jellyfin: 'Jellyfin', stremio: 'Stremio', bundle: 'Jellyfin + Stremio' })[serviceType(plan)];
}

module.exports = { serviceType, catalogueState, stremioContext, context, evaluate, evaluatePlan, planByCode, assertSellablePlan, assertSellableCode, deliveryLabel };
