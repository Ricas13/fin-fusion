'use strict';

const { query } = require('../db');
const stremioFoundation = require('../stremio/foundation');

function serviceType(plan) {
  const value = String(plan?.service_type || 'jellyfin').toLowerCase();
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
  const [servers, indexes] = await Promise.all([
    query(`SELECT COUNT(*)::int n
           FROM jellyfin_servers
           WHERE enabled=TRUE AND stremio_enabled=TRUE AND public_url IS NOT NULL
             AND COALESCE(placement_mode,'active')='active'
             AND health_status IN ('healthy','degraded')`),
    query(`SELECT COUNT(*)::int n
           FROM stremio_media_index_state s
           JOIN jellyfin_servers j ON j.id=s.server_id
           WHERE j.enabled=TRUE AND j.stremio_enabled=TRUE AND j.public_url IS NOT NULL
             AND s.status='ready' AND s.item_count>0`)
  ]);
  return {
    runtimeReady: stremioFoundation.runtimeReady(),
    eligibleServers: Number(servers.rows[0]?.n || 0),
    readyIndexes: Number(indexes.rows[0]?.n || 0)
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

function deliveryLabel(plan) {
  return ({ jellyfin: 'Jellyfin', stremio: 'Stremio', bundle: 'Jellyfin + Stremio' })[serviceType(plan)];
}

module.exports = { serviceType, catalogueState, stremioContext, context, evaluate, deliveryLabel };
