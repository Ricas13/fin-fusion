'use strict';

const { query } = require('../db');
const serviceCatalog = require('../catalog/service-catalog');
const planServers = require('./plan-servers');
const userCapacity = require('./user-capacity');
const mediaProvider = require('../media-servers/provider');
const placement = require('./placement');
const outbound = require('../security/outbound-url-policy');

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

async function safeTestUrl(server, { resolveHost = outbound.resolveHost } = {}) {
  const value = String(server?.public_url || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return null;
    const addresses = await resolveHost(parsed.hostname);
    if (!Array.isArray(addresses) || !addresses.length) return null;
    if (addresses.some(address => {
      const info = outbound.classify(address);
      return info.hard || info.private;
    })) return null;
    return mediaProvider.apiUrl(parsed.toString(), server.media_server_type || 'jellyfin', mediaProvider.healthEndpoint(server.media_server_type || 'jellyfin')).toString();
  } catch (_) {
    return null;
  }
}

async function availableServers(plan, { db = query } = {}) {
  const provider = mediaServerType(plan);
  if (!provider) return [];
  const servers = (await planServers.eligibleServersForPlan(plan, { enabledOnly: true, forPlacement: true, db }))
    .filter(server => mediaProvider.normalizeType(server.media_server_type || 'jellyfin') === provider)
    .filter(server => serverAllowsPlan(server, plan));
  if (!servers.length) return [];
  const decorated = await userCapacity.decorateServers(servers, db);
  return decorated.filter(server => server.full !== true);
}

async function choicesForPlan(plan, { db = query, resolveTestHost = outbound.resolveHost } = {}) {
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
    if (!group.testUrl) group.testUrl = await safeTestUrl(server, { resolveHost: resolveTestHost });
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

async function selectServerForLocation(plan, requested, { db = query, requireSelection = true } = {}) {
  const provider = mediaServerType(plan);
  if (!provider) return null;
  const location = await resolveAcquisitionLocation(plan, requested, { db, requireSelection });
  const available = await availableServers(plan, { db });
  const candidates = location ? available.filter(server => matchesPreference(server, location)) : available;
  if (!candidates.length) {
    const error = new Error('That server location is no longer available. Choose another location.');
    error.code = 'MEDIA_LOCATION_UNAVAILABLE';
    throw error;
  }
  const ids = candidates.map(server => server.id);
  const playback = ids.length ? await db(`
    SELECT server_id,COUNT(DISTINCT jellyfin_session_id)::int AS active_streams
    FROM active_playback_sessions
    WHERE server_id=ANY($1::uuid[])
    GROUP BY server_id
  `, [ids]) : { rows: [] };
  const streams = new Map(playback.rows.map(row => [String(row.server_id), Number(row.active_streams || 0)]));
  for (const server of candidates) server.active_streams = streams.get(String(server.id)) || 0;
  const selected = placement.selectServer(candidates, plan?.placement_strategy);
  if (!selected) {
    const error = new Error('That server location is no longer available. Choose another location.');
    error.code = 'MEDIA_LOCATION_UNAVAILABLE';
    throw error;
  }
  return { ...selected, selected_location: location || locationLabel(selected.location) };
}

async function selectServerForLocationLocked(plan, requested, { db = query, requireSelection = true } = {}) {
  // Plans may share physical servers. Lock every candidate in deterministic ID
  // order before the final capacity read so acquisitions from different plans
  // cannot reserve the same final place or deadlock while switching candidates.
  const location = await resolveAcquisitionLocation(plan, requested, { db, requireSelection });
  const available = await availableServers(plan, { db });
  const candidates = location ? available.filter(server => matchesPreference(server, location)) : available;
  if (!candidates.length) {
    const error = new Error('That server location is no longer available. Choose another location.');
    error.code = 'MEDIA_LOCATION_UNAVAILABLE';
    throw error;
  }
  const ids = candidates.map(server => String(server.id)).sort();
  await db('SELECT id FROM jellyfin_servers WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  // Re-evaluate after taking the locks because a transaction which held one of
  // these rows may just have committed a checkout/free reservation.
  return selectServerForLocation(plan, location, { db, requireSelection: false });
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
  const found = choices.find(choice => locationKey(choice.value) === locationKey(wanted));
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

async function reservedServerIfEligible(plan, serverId, requestedLocation = null, { db = query } = {}) {
  if (!serverId || !mediaServerType(plan)) return null;
  const provider = mediaServerType(plan);
  const servers = (await planServers.eligibleServersForPlan(plan, { enabledOnly: true, forPlacement: true, db }))
    .filter(server => mediaProvider.normalizeType(server.media_server_type || 'jellyfin') === provider)
    .filter(server => serverAllowsPlan(server, plan));
  const server = servers.find(candidate => String(candidate.id) === String(serverId));
  if (!server || (requestedLocation && !matchesPreference(server, requestedLocation))) return null;
  return { ...server, selected_location: locationLabel(server.location) };
}

async function existingAssignedServerForPlan(plan, serverId, requestedLocation = null, { db = query } = {}) {
  if (!serverId || !mediaServerType(plan)) return null;
  const provider = mediaServerType(plan);
  // Existing paid customers already consume their physical slot. Reusing that
  // assignment for an eligible target plan is not a new placement, so fullness,
  // allow_new_users, placement drain and transient health must not force a move
  // or block a commercial plan change. A server explicitly disabled by an
  // administrator is different: do not start a new paid change against it.
  // The target plan pool/provider must still allow the server.
  const servers = (await planServers.eligibleServersForPlan(plan, { enabledOnly: true, forPlacement: false, db }))
    .filter(server => mediaProvider.normalizeType(server.media_server_type || 'jellyfin') === provider);
  const server = servers.find(candidate => String(candidate.id) === String(serverId));
  if (!server || (requestedLocation && !matchesPreference(server, requestedLocation))) return null;
  return { ...server, selected_location: locationLabel(server.location) };
}

async function committedReservedServer(plan, serverId, requestedLocation = null, { db = query } = {}) {
  if (!serverId || !mediaServerType(plan)) return null;
  const provider = mediaServerType(plan);
  const result = await db(`
    SELECT *
    FROM jellyfin_servers
    WHERE id=$1
    LIMIT 1
  `, [serverId]);
  const server = result.rows[0] || null;
  if (!server) return null;
  if (mediaProvider.normalizeType(server.media_server_type || 'jellyfin') !== provider) return null;
  // Pool membership, class labels, allow_new_users and location display text
  // may change after checkout starts and must not erase already-promised paid
  // capacity. Actual operational availability is different: if the server was
  // disabled/drained or is no longer healthy enough for the configured
  // placement policy, let the caller select another server in the same chosen
  // location (or surface a paid-but-unfulfilled incident).
  const healthMode = await planServers.placementHealthMode(db);
  if (server.enabled !== true
      || String(server.placement_mode || 'active') !== 'active'
      || !planServers.healthEligible(server, healthMode)) return null;
  return {
    ...server,
    selected_location: requestedLocation
      ? locationLabel(requestedLocation)
      : locationLabel(server.location)
  };
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
  if (server.enabled !== true) {
    const error = new Error('The media server assigned to this subscription is currently unavailable.');
    error.code = 'ASSIGNED_MEDIA_SERVER_UNAVAILABLE';
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
  // Callers may already have a decorated media-server row or a persisted
  // Jellyfin/Emby account row. Account rows use `server_id` while their own
  // `id` is the account id; never mistake that account id for a server FK.
  const serverId = server?.server_id || server?.id || null;
  if (!subscriptionId || !serverId) return null;
  const location = locationLabel(server?.server_location ?? server?.location);
  const result = await db(`
    UPDATE subscriptions
    SET media_server_id=CASE WHEN $4::boolean OR media_server_id IS NULL THEN $2 ELSE media_server_id END,
        media_location_snapshot=CASE WHEN $4::boolean OR media_server_id IS NULL THEN $3 ELSE media_location_snapshot END,
        media_location_preference=CASE WHEN $4::boolean OR media_location_preference IS NULL OR media_location_preference='' THEN $3 ELSE media_location_preference END,
        updated_at=NOW()
    WHERE id=$1
    RETURNING media_server_id,media_location_preference,media_location_snapshot
  `, [subscriptionId, serverId, location, Boolean(overwrite)]);
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
  selectServerForLocation,
  selectServerForLocationLocked,
  matchesPreference,
  reservedServerIfEligible,
  existingAssignedServerForPlan,
  committedReservedServer,
  assignedServer,
  persistAssignment
};
