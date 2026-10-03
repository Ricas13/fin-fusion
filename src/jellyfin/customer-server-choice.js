'use strict';

const { query } = require('../db');
const serviceCatalog = require('../catalog/service-catalog');
const planServers = require('./plan-servers');
const userCapacity = require('./user-capacity');
const mediaProvider = require('../media-servers/provider');

function mediaServerType(plan) {
  const type = serviceCatalog.serviceType(plan);
  if (type === 'emby') return 'emby';
  if (type === 'jellyfin' || type === 'bundle') return 'jellyfin';
  return null;
}

function locationLabel(value) {
  const label = String(value || '').trim().replace(/\s+/g, ' ');
  return label || 'Default';
}

function locationKey(value) {
  return locationLabel(value).toLocaleLowerCase('en-GB');
}

function accessKind(plan) {
  const billing = String(plan?.billing_interval_snapshot || plan?.contract_billing_interval || plan?.billing_interval || '').toLowerCase();
  const price = Number(plan?.price_minor_snapshot ?? plan?.contract_price_minor ?? plan?.price_minor ?? 0);
  if (billing === 'trial') return 'trial';
  return price > 0 ? 'paid' : 'free';
}

function serverAllowsPlan(server, plan) {
  const kind = accessKind(plan);
  if (!server?.allow_new_users) return false;
  if (kind === 'trial' && !server.trial_enabled) return false;
  if (kind === 'paid' && !server.paid_enabled) return false;
  return true;
}

function safeTestUrl(server) {
  const value = String(server?.public_url || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return null;
    return mediaProvider.apiUrl(parsed.toString(), server.media_server_type || 'jellyfin', mediaProvider.healthEndpoint(server.media_server_type || 'jellyfin')).toString();
  } catch (_) {
    return null;
  }
}

async function availableServers(plan, { db = query } = {}) {
  const provider = mediaServerType(plan);
  if (!provider) return [];
  const servers = (await planServers.eligibleServersForPlan(plan, { enabledOnly: true, forPlacement: true }))
    .filter(server => mediaProvider.normalizeType(server.media_server_type || 'jellyfin') === provider)
    .filter(server => serverAllowsPlan(server, plan));
  if (!servers.length) return [];
  const decorated = await userCapacity.decorateServers(servers, db);
  return decorated.filter(server => server.full !== true);
}

async function choicesForPlan(plan, { db = query } = {}) {
  const provider = mediaServerType(plan);
  if (!provider) return [];
  const servers = await availableServers(plan, { db });
  const groups = new Map();
  for (const server of servers) {
    const label = locationLabel(server.location);
    const key = locationKey(label);
    let group = groups.get(key);
    if (!group) {
      group = { value: label, label, key, provider, servers: [], remaining: 0, unlimited: false, testUrl: null };
      groups.set(key, group);
    }
    group.servers.push(server);
    if (server.remaining_users == null) group.unlimited = true;
    else group.remaining += Math.max(0, Number(server.remaining_users || 0));
    if (!group.testUrl) group.testUrl = safeTestUrl(server);
  }
  return Array.from(groups.values())
    .map(group => ({
      value: group.value,
      label: group.label,
      provider: group.provider,
      serverCount: group.servers.length,
      remaining: group.unlimited ? null : group.remaining,
      testUrl: group.testUrl
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en-GB'));
}

async function resolveAcquisitionLocation(plan, requested, { db = query, requireSelection = true } = {}) {
  if (!mediaServerType(plan)) return null;
  const choices = await choicesForPlan(plan, { db });
  if (!choices.length) {
    const error = new Error(`No eligible ${mediaProvider.label(mediaServerType(plan))} server is currently available for this plan.`);
    error.code = 'MEDIA_LOCATION_UNAVAILABLE';
    throw error;
  }
  if (choices.length === 1) return choices[0].value;

  const wanted = String(requested || '').trim();
  if (!wanted) {
    if (!requireSelection) return null;
    const error = new Error('Choose a server location before continuing.');
    error.code = 'MEDIA_LOCATION_REQUIRED';
    throw error;
  }
  const found = choices.find(choice => choice.key === locationKey(wanted));
  if (!found) {
    const error = new Error('That server location is no longer available. Choose another location.');
    error.code = 'MEDIA_LOCATION_UNAVAILABLE';
    throw error;
  }
  return found.value;
}

function matchesPreference(server, preference) {
  if (!preference) return true;
  return locationKey(server?.location) === locationKey(preference);
}

async function assignedServer(entitlement, expectedProvider = null, { db = query } = {}) {
  const serverId = entitlement?.media_server_id;
  if (!serverId) return null;
  const provider = expectedProvider || mediaServerType(entitlement);
  const result = await db(`
    SELECT *
    FROM jellyfin_servers
    WHERE id=$1
    LIMIT 1
  `, [serverId]);
  const server = result.rows[0] || null;
  if (!server) {
    const error = new Error('The media server assigned to this subscription no longer exists.');
    error.code = 'ASSIGNED_MEDIA_SERVER_MISSING';
    throw error;
  }
  if (provider && mediaProvider.normalizeType(server.media_server_type || 'jellyfin') !== provider) {
    const error = new Error('The media server assigned to this subscription has the wrong provider type.');
    error.code = 'ASSIGNED_MEDIA_SERVER_PROVIDER_MISMATCH';
    throw error;
  }
  return server;
}

async function persistAssignment(subscriptionId, server, { overwrite = false, db = query } = {}) {
  if (!subscriptionId || !server?.id) return null;
  const location = locationLabel(server.location);
  const result = await db(`
    UPDATE subscriptions
    SET media_server_id=CASE WHEN $4::boolean OR media_server_id IS NULL THEN $2 ELSE media_server_id END,
        media_location_snapshot=CASE WHEN $4::boolean OR media_server_id IS NULL THEN $3 ELSE media_location_snapshot END,
        media_location_preference=COALESCE(NULLIF(media_location_preference,''),$3),
        updated_at=NOW()
    WHERE id=$1
    RETURNING media_server_id,media_location_preference,media_location_snapshot
  `, [subscriptionId, server.id, location, Boolean(overwrite)]);
  return result.rows[0] || null;
}

module.exports = {
  mediaServerType,
  locationLabel,
  locationKey,
  accessKind,
  serverAllowsPlan,
  safeTestUrl,
  availableServers,
  choicesForPlan,
  resolveAcquisitionLocation,
  matchesPreference,
  assignedServer,
  persistAssignment
};
