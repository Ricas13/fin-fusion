'use strict';

const { query } = require('../db');
const planServers = require('./plan-servers');
const userCapacity = require('./user-capacity');
const outbound = require('../security/outbound-url-policy');

function cleanLocation(value) {
  return String(value || '').trim().slice(0, 100);
}

function serviceType(plan) {
  const value = String(plan?.service_type_snapshot || plan?.service_type || '').toLowerCase();
  return value === 'emby' ? 'emby' : ['jellyfin', 'bundle'].includes(value) ? 'jellyfin' : null;
}

function accessKind(plan) {
  if (String(plan?.billing_interval_snapshot || plan?.billing_interval || plan?.contract_billing_interval || '') === 'trial') return 'trial';
  return Number(plan?.price_minor_snapshot ?? plan?.price_minor ?? plan?.contract_price_minor ?? 0) > 0 ? 'paid' : 'free';
}

function snapshot(plan) {
  const raw = plan?.commercial_snapshot;
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function preferredLocation(plan) {
  return cleanLocation(plan?.preferred_location || snapshot(plan).preferredLocation || '');
}

function normalizeKey(value) {
  return cleanLocation(value).toLocaleLowerCase('en-GB');
}

function locationLabel(server) {
  return cleanLocation(server?.location) || 'Default';
}

function eligibleForAccess(server, kind) {
  if (!server?.enabled || !server?.allow_new_users || server?.full) return false;
  if (kind === 'trial' && !server.trial_enabled) return false;
  if (kind === 'paid' && !server.paid_enabled) return false;
  return true;
}

async function availableServersForPlan(plan) {
  if (!serviceType(plan)) return [];
  const base = await planServers.eligibleServersForPlan(plan, { enabledOnly: true, forPlacement: true });
  if (!base.length) return [];
  const decorated = await userCapacity.decorateServers(base);
  const kind = accessKind(plan);
  return decorated.filter(server => eligibleForAccess(server, kind));
}

function groupLocations(servers) {
  const groups = new Map();
  for (const server of servers || []) {
    const label = locationLabel(server);
    const key = normalizeKey(label);
    const current = groups.get(key) || { key, label, servers: [], remaining: 0, unlimited: false };
    current.servers.push(server);
    if (server.remaining_users == null) current.unlimited = true;
    else current.remaining += Math.max(0, Number(server.remaining_users || 0));
    groups.set(key, current);
  }
  return Array.from(groups.values())
    .map(group => ({
      location: group.label,
      serverCount: group.servers.length,
      remaining: group.unlimited ? null : group.remaining,
      serverIds: group.servers.map(server => server.id)
    }))
    .sort((a, b) => a.location.localeCompare(b.location));
}

async function availableLocationsForPlan(plan) {
  return groupLocations(await availableServersForPlan(plan));
}

async function decoratePlans(plans) {
  return Promise.all((Array.isArray(plans) ? plans : []).map(async plan => {
    if (!serviceType(plan)) return { ...plan, media_locations: [], media_location_choice_required: false };
    const locations = await availableLocationsForPlan(plan);
    return {
      ...plan,
      media_locations: locations,
      media_location_choice_required: locations.length > 1,
      media_location_default: locations.length === 1 ? locations[0].location : null
    };
  }));
}

async function assertRequestedLocation(plan, requested) {
  const locations = await availableLocationsForPlan(plan);
  if (!locations.length) {
    const error = new Error('No eligible streaming server is currently available for this plan.');
    error.code = 'MEDIA_LOCATION_UNAVAILABLE';
    throw error;
  }
  if (locations.length === 1) return locations[0].location;
  const clean = cleanLocation(requested);
  if (!clean) {
    const error = new Error('Choose a server location before continuing.');
    error.code = 'MEDIA_LOCATION_REQUIRED';
    throw error;
  }
  const match = locations.find(item => normalizeKey(item.location) === normalizeKey(clean));
  if (!match) {
    const error = new Error('That server location is no longer available. Choose another location and try again.');
    error.code = 'MEDIA_LOCATION_UNAVAILABLE';
    throw error;
  }
  return match.location;
}

function filterServersByPreference(plan, servers) {
  const preferred = preferredLocation(plan);
  if (!preferred) return servers || [];
  const key = normalizeKey(preferred);
  return (servers || []).filter(server => normalizeKey(locationLabel(server)) === key);
}

async function planByCode(planCode) {
  const result = await query(`SELECT * FROM plans
    WHERE code=$1 AND active=TRUE AND visible=TRUE AND archived_at IS NULL
      AND (effective_from IS NULL OR effective_from<=NOW())
      AND (effective_until IS NULL OR effective_until>NOW())
    LIMIT 1`, [String(planCode || '')]);
  return result.rows[0] || null;
}

async function probeUrl(url) {
  const started = Date.now();
  try {
    const response = await outbound.safeFetch(url, {
      purpose: 'customer media location latency test',
      method: 'HEAD',
      timeoutMs: 2500,
      maxBytes: 4096,
      redirect: 'manual'
    });
    return { ok: response.status >= 200 && response.status < 500, latencyMs: Date.now() - started };
  } catch (_) {
    return { ok: false, latencyMs: null };
  }
}

async function testLocationsForPlan(plan) {
  const servers = await availableServersForPlan(plan);
  const grouped = new Map();
  for (const server of servers) {
    const location = locationLabel(server);
    const key = normalizeKey(location);
    const current = grouped.get(key) || { location, urls: [] };
    if (server.public_url) current.urls.push(String(server.public_url));
    grouped.set(key, current);
  }
  const results = [];
  for (const group of grouped.values()) {
    const probes = [];
    for (const url of group.urls.slice(0, 2)) probes.push(await probeUrl(url));
    const successful = probes.filter(item => item.ok && Number.isFinite(item.latencyMs));
    results.push({
      location: group.location,
      available: group.urls.length > 0 && successful.length > 0,
      latencyMs: successful.length ? Math.min(...successful.map(item => item.latencyMs)) : null
    });
  }
  return results.sort((a, b) => {
    if (a.latencyMs == null && b.latencyMs == null) return a.location.localeCompare(b.location);
    if (a.latencyMs == null) return 1;
    if (b.latencyMs == null) return -1;
    return a.latencyMs - b.latencyMs;
  });
}

module.exports = {
  cleanLocation,
  serviceType,
  accessKind,
  preferredLocation,
  locationLabel,
  availableServersForPlan,
  availableLocationsForPlan,
  decoratePlans,
  assertRequestedLocation,
  filterServersByPreference,
  planByCode,
  testLocationsForPlan
};
