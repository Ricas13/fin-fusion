'use strict';

const express = require('express');
const { query } = require('../db');
const routeRateLimit = require('../security/route-rate-limit');
const operations = require('../platform/operations-settings');
const modules = require('../modules/registry');
const entitlements = require('./entitlements');
const managedRuntime = require('./managed-runtime');
const managedPlayback = require('./managed-playback-lifecycle');
const externalRuntime = require('./external-direct-runtime');
const householdAccess = require('./household-access');
const runtimeSettings = require('./runtime-settings');

function stremioRateIdentity(req) {
  const token = String(req.params?.token || '').trim();
  return token ? `install:${token}` : null;
}

const manifestLimit = routeRateLimit.middleware({ scope: 'stremio-manifest', max: 60, windowSeconds: 60, identity: stremioRateIdentity, reason: 'protocol_rate_limit' });
const streamLimit = routeRateLimit.middleware({ scope: 'stremio-stream', max: 240, windowSeconds: 60, identity: stremioRateIdentity, reason: 'protocol_rate_limit' });
const playbackLimit = routeRateLimit.middleware({ scope: 'stremio-playback-control', max: 1200, windowSeconds: 60, identity: stremioRateIdentity, reason: 'protocol_rate_limit' });
const PLAYBACK_REDIRECT_STATUS = 302;
const STREAM_RESULT_CACHE_TTL_MS = 15000;
const STREAM_RESULT_CACHE_MAX = 250;
const streamResultCache = new Map();

function safeLogText(value, max = 500) {
  return String(value ?? '').replace(/[\r\n\u2028\u2029]/g, ' ').slice(0, max);
}

function streamCacheKey(entitlementId, type, videoId, origin) {
  return [entitlementId, type, videoId, origin].map(value => encodeURIComponent(String(value || ''))).join('|');
}

function copyStreams(streams) {
  return Array.isArray(streams) ? streams.map(stream => ({ ...stream })) : [];
}

function cachedStreams(entitlementId, type, videoId, origin) {
  const key = streamCacheKey(entitlementId, type, videoId, origin);
  const hit = streamResultCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    streamResultCache.delete(key);
    return null;
  }
  streamResultCache.delete(key);
  streamResultCache.set(key, hit);
  return copyStreams(hit.streams);
}

function rememberStreams(entitlementId, type, videoId, origin, streams) {
  const key = streamCacheKey(entitlementId, type, videoId, origin);
  streamResultCache.set(key, { expiresAt: Date.now() + STREAM_RESULT_CACHE_TTL_MS, streams: copyStreams(streams) });
  while (streamResultCache.size > STREAM_RESULT_CACHE_MAX) {
    const oldest = streamResultCache.keys().next().value;
    if (oldest === undefined) break;
    streamResultCache.delete(oldest);
  }
}

function clearStreamResultCache() {
  streamResultCache.clear();
}

function enabled() {
  return runtimeSettings.enabled() && modules.isEnabled('stremio');
}

function cors(_req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After,X-CAPTAiNFiN-429-Reason');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

async function loadRuntimeSetting(_req, res, next) {
  try {
    await runtimeSettings.ensureLoaded();
    return next();
  } catch (error) {
    console.error('Stremio runtime setting unavailable:', safeLogText(error?.message || error, 300));
    return res.status(503).json({ error: 'Temporarily unavailable' });
  }
}

function manifest() {
  return {
    id: 'cc.captainfin.jellyfin',
    version: '1.4.0',
    name: 'CAPTAiNFiN',
    description: 'Stream results included with your CAPTAiNFiN subscription.',
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    types: ['movie', 'series'],
    catalogs: [],
    behaviorHints: { configurable: false, p2p: false }
  };
}

async function publicOrigin(req) {
  try {
    const cfg = await operations.get();
    if (cfg.publicBaseUrl) return String(cfg.publicBaseUrl).replace(/\/$/, '');
  } catch (_error) {}
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${host}`.replace(/\/$/, '');
}

async function hasExplicitSources(entitlement) {
  const result = await query(
    `SELECT EXISTS(SELECT 1 FROM subscriptions s JOIN plan_stremio_sources ps ON ps.plan_id=s.plan_id AND ps.enabled=TRUE WHERE s.id=$1) yes`,
    [entitlement.subscription_id]
  );
  return result.rows[0]?.yes === true;
}

async function managedMapping(entitlementId, mappingId) {
  const result = await query(
    `SELECT sma.*,js.name server_name,js.base_url,js.public_url,js.enabled server_enabled,js.stremio_enabled,
            ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled
     FROM stremio_managed_accounts sma
     JOIN jellyfin_servers js ON js.id=sma.server_id
     JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
     WHERE sma.id=$2 AND sma.entitlement_id=$1 AND sma.status='active'
       AND js.enabled=TRUE AND js.stremio_enabled=TRUE AND ja.disabled=FALSE`,
    [entitlementId, mappingId]
  );
  return result.rows[0] || null;
}

function settledStreams(result, label) {
  if (result.status === 'fulfilled') return Array.isArray(result.value) ? result.value : [];
  console.error(`Stremio ${label} source resolution failed:`, safeLogText(result.reason?.message || result.reason));
  return [];
}

async function claimHouseholdOrReject(entitlement, req, res, kind) {
  const decision = await householdAccess.claim(entitlement, req, { kind });
  if (!decision.allowed) {
    householdAccess.applyDeniedResponse(res, decision);
    return null;
  }
  return decision;
}

function createStremioRuntimeRouter() {
  const router = express.Router();
  router.use('/stremio', cors, loadRuntimeSetting);
  router.options('/stremio/*', (_req, res) => res.sendStatus(204));

  // Managed playback tracking exists only to clean up per-playback Jellyfin
  // credentials and lifecycle state. Household admission is network-based and
  // independent of the number of simultaneous Stremio streams.
  managedPlayback.startManager({ intervalMs: 5000 });

  router.get('/stremio/:token/manifest.json', manifestLimit, async (req, res) => {
    if (!enabled()) return res.status(404).json({ error: 'Not found' });
    try {
      const entitlement = await entitlements.findByInstallToken(req.params.token);
      if (!entitlement) return res.status(404).json({ error: 'Not found' });
      await entitlements.markUse(entitlement.id, 'manifest');
      return res.json(manifest());
    } catch (_error) {
      console.error('Stremio manifest request failed.');
      return res.status(503).json({ error: 'Temporarily unavailable' });
    }
  });

  router.get('/stremio/:token/stream/:type/:videoId.json', streamLimit, async (req, res) => {
    if (!enabled()) return res.json({ streams: [] });
    try {
      const entitlement = await entitlements.findByInstallToken(req.params.token);
      if (!entitlement) return res.json({ streams: [] });
      const type = String(req.params.type || '');
      const videoId = String(req.params.videoId || '');
      const household = await householdAccess.preview(entitlement, req, { kind: 'stream_results' });
      if (household && household.allowed === false) {
        await entitlements.markUse(entitlement.id, 'stream').catch(error => console.warn('Unable to update Stremio usage timestamp:', safeLogText(error?.message || error, 300)));
        const origin = await publicOrigin(req);
        return res.json({ streams: [householdAccess.deniedStream(household, { externalUrl: `${origin}/account/stremio` })] });
      }
      const origin = await publicOrigin(req);
      const cached = cachedStreams(entitlement.id, type, videoId, origin);
      if (cached) {
        await entitlements.markUse(entitlement.id, 'stream').catch(error => console.warn('Unable to update Stremio usage timestamp:', safeLogText(error?.message || error, 300)));
        return res.json({ streams: cached });
      }
      const delivery = { portalBase: origin, installToken: req.params.token };
      const [managedResult, externalResult] = await Promise.allSettled([
        managedRuntime.streamsFor(entitlement, type, videoId, delivery),
        externalRuntime.streamsFor(entitlement, type, videoId, delivery)
      ]);
      const managed = settledStreams(managedResult, 'managed');
      const external = settledStreams(externalResult, 'external');
      const streams = [...managed, ...external];
      rememberStreams(entitlement.id, type, videoId, origin, streams);
      await entitlements.markUse(entitlement.id, 'stream').catch(error => console.warn('Unable to update Stremio usage timestamp:', safeLogText(error?.message || error, 300)));
      return res.json({ streams });
    } catch (error) {
      console.error('Stremio stream request failed before source resolution:', safeLogText(error?.message || error));
      return res.json({ streams: [] });
    }
  });

  // Managed playback remains a control-plane hop. PlaybackInfo is refreshed,
  // the household network lease is claimed/refreshed, a short-lived Jellyfin
  // credential is prepared for lifecycle cleanup, then CAPTAiNFiN exits through
  // a plain temporary redirect.
  router.get('/stremio/:token/play/:mappingId/:itemId/:mediaSourceId', playbackLimit, async (req, res) => {
    if (!enabled()) return res.status(404).end();
    const playbackKey = String(req.query.playbackKey || '');
    try {
      const entitlement = await entitlements.findByInstallToken(req.params.token);
      if (!entitlement || !playbackKey) return res.status(404).end();
      const mapping = await managedMapping(entitlement.id, req.params.mappingId);
      if (!mapping) return res.status(404).end();
      const playback = await managedRuntime.playbackInfo(mapping, req.params.itemId, req.params.mediaSourceId);
      const source = managedRuntime.mediaSource(playback, req.params.mediaSourceId);
      if (!source) return res.status(404).end();
      const household = await claimHouseholdOrReject(entitlement, req, res, 'managed_playback');
      if (!household) return;
      const playMethod = managedRuntime.playMethodFor(source);
      const playSessionId = String(playback?.PlaySessionId || req.query.playSessionId || '');
      if (!playMethod) return res.status(502).end();
      const started = await managedPlayback.start(mapping, playbackKey, {
        itemId: req.params.itemId,
        mediaSourceId: req.params.mediaSourceId,
        playSessionId,
        playMethod
      });
      const target = managedRuntime.playbackUrl(mapping, req.params.itemId, source, playback, { accessToken: started.accessToken, deviceId: started.deviceId });
      await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES(NULL,'stremio.managed_playback.redirected','stremio_entitlement',$1,$2::jsonb)`,
        [entitlement.id, JSON.stringify({ serverId: mapping.server_id, jellyfinSessionId: started.jellyfinSessionId || null, playMethod: target.playMethod, householdDecision: household.decision })]
      ).catch(() => {});
      return res.redirect(PLAYBACK_REDIRECT_STATUS, target.url);
    } catch (error) {
      console.error('Managed Stremio playback control failed:', safeLogText(error?.message || error, 300));
      return res.status(502).end();
    }
  });

  // External sources also take one control-plane hop so a real playback start,
  // rather than a catalogue lookup, owns the household lease. The response is
  // still a temporary redirect directly to Jellyfin; CAPTAiNFiN never receives media bytes.
  router.get('/stremio/:token/external-play/:sourceId/:itemId/:mediaSourceId', playbackLimit, async (req, res) => {
    if (!enabled()) return res.status(404).end();
    try {
      const entitlement = await entitlements.findByInstallToken(req.params.token);
      if (!entitlement) return res.status(404).end();
      const target = await externalRuntime.playbackTargetFor(entitlement, req.params.sourceId, req.params.itemId, req.params.mediaSourceId);
      if (!target) return res.status(404).end();
      const household = await claimHouseholdOrReject(entitlement, req, res, 'external_playback');
      if (!household) return;
      await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES(NULL,'stremio.external_playback.redirected','stremio_entitlement',$1,$2::jsonb)`,
        [entitlement.id, JSON.stringify({ sourceId: req.params.sourceId, householdDecision: household.decision })]
      ).catch(() => {});
      return res.redirect(PLAYBACK_REDIRECT_STATUS, target);
    } catch (error) {
      console.error('External Stremio playback control failed:', safeLogText(error?.message || error, 300));
      return res.status(502).end();
    }
  });

  // Historical byte-proxy paths remain retired. Current managed and external
  // playback both use short control-plane redirects and no media relay.
  const retiredPlayback = (_req, res) => res.status(410).end();
  router.get('/stremio/:token/jellyfin/:itemId/:mediaSourceId', playbackLimit, retiredPlayback);
  router.get('/stremio/:token/source/:sourceId/:itemId/:mediaSourceId', playbackLimit, retiredPlayback);
  return router;
}

module.exports = {
  available: true,
  enabled,
  manifest,
  publicOrigin,
  hasExplicitSources,
  managedMapping,
  settledStreams,
  stremioRateIdentity,
  claimHouseholdOrReject,
  PLAYBACK_REDIRECT_STATUS,
  STREAM_RESULT_CACHE_TTL_MS,
  STREAM_RESULT_CACHE_MAX,
  streamCacheKey,
  cachedStreams,
  rememberStreams,
  clearStreamResultCache,
  createStremioRuntimeRouter
};
