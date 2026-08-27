'use strict';

const express = require('express');
const { query } = require('../db');
const routeRateLimit = require('../security/route-rate-limit');
const operations = require('../platform/operations-settings');
const modules = require('../modules/registry');
const entitlements = require('./entitlements');
const managedRuntime = require('./managed-runtime');
const externalRuntime = require('./external-direct-runtime');
const householdAccess = require('./household-access');
const blockedMedia = require('./blocked-media');
const runtimeSettings = require('./runtime-settings');
const mediaEdge = require('./media-edge-grant');

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
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After,X-CAPTAiNFiN-429-Reason,Accept-Ranges,Content-Length,Content-Range');
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
  return new URL(await operations.absoluteUrl(req, '/')).origin;
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

async function deniedStreamResponse(entitlement, req, type, videoId, decision) {
  await entitlements.markUse(entitlement.id, 'stream').catch(error => console.warn('Unable to update Stremio usage timestamp:', safeLogText(error?.message || error, 300)));
  const origin = await publicOrigin(req);
  return {
    streams: [
      householdAccess.deniedStream(decision, {
        url: blockedMedia.playbackUrl({ origin, installToken: req.params.token, type, videoId }),
        videoSize: blockedMedia.MEDIA_SIZE
      })
    ]
  };
}

async function claimDirectStreamResult(entitlement, req) {
  return householdAccess.claim(entitlement, req, { kind: 'direct_stream_result' });
}

async function sendHouseholdBlockedMedia(req, res) {
  if (!enabled()) return res.status(404).end();
  try {
    const entitlement = await entitlements.findByInstallToken(req.params.token);
    if (!entitlement) return res.status(404).end();
    await entitlements.markUse(entitlement.id, 'stream').catch(error => console.warn('Unable to update Stremio usage timestamp:', safeLogText(error?.message || error, 300)));
    return blockedMedia.send(req, res);
  } catch (error) {
    console.error('Stremio household block media failed:', safeLogText(error?.message || error, 300));
    return res.status(502).end();
  }
}

function createStremioRuntimeRouter() {
  const router = express.Router();
  router.all('/stremio-edge/authorize', mediaEdge.authorizeHandler);
  router.use(mediaEdge.runtimeProtectionMiddleware);
  router.use('/stremio', cors, loadRuntimeSetting);
  router.options('/stremio/*', (_req, res) => res.sendStatus(204));

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

      // Preview first so a disallowed household never causes source credentials
      // to be resolved into a response. The actual claim happens immediately
      // before raw Jellyfin URLs are handed to Stremio because there is no
      // CAPTAiNFiN playback hop anymore.
      const preview = await householdAccess.preview(entitlement, req, { kind: 'stream_results' });
      if (preview && preview.allowed === false) return res.json(await deniedStreamResponse(entitlement, req, type, videoId, preview));

      const origin = await publicOrigin(req);
      const cached = cachedStreams(entitlement.id, type, videoId, origin);
      if (cached) {
        const household = await claimDirectStreamResult(entitlement, req);
        if (!household.allowed) return res.json(await deniedStreamResponse(entitlement, req, type, videoId, household));
        await entitlements.markUse(entitlement.id, 'stream').catch(error => console.warn('Unable to update Stremio usage timestamp:', safeLogText(error?.message || error, 300)));
        return res.json({ streams: cached });
      }

      const [managedResult, externalResult] = await Promise.allSettled([
        managedRuntime.streamsFor(entitlement, type, videoId),
        externalRuntime.streamsFor(entitlement, type, videoId)
      ]);
      const managed = settledStreams(managedResult, 'managed');
      const external = settledStreams(externalResult, 'external');
      const streams = [...managed, ...external];

      if (streams.length) {
        const household = await claimDirectStreamResult(entitlement, req);
        if (!household.allowed) return res.json(await deniedStreamResponse(entitlement, req, type, videoId, household));
        rememberStreams(entitlement.id, type, videoId, origin, streams);
      }
      await entitlements.markUse(entitlement.id, 'stream').catch(error => console.warn('Unable to update Stremio usage timestamp:', safeLogText(error?.message || error, 300)));
      return res.json({ streams });
    } catch (error) {
      console.error('Stremio stream request failed before source resolution:', safeLogText(error?.message || error));
      return res.json({ streams: [] });
    }
  });

  router.get('/stremio/:token/household-blocked/:type/:videoId.mp4', playbackLimit, sendHouseholdBlockedMedia);
  router.head('/stremio/:token/household-blocked/:type/:videoId.mp4', playbackLimit, sendHouseholdBlockedMedia);

  // Compatibility only for stream results cached by clients before the raw-file
  // rollout. This route no longer calls PlaybackInfo, authenticates a fresh
  // Jellyfin device, or reports /Sessions/Playing. It simply re-checks household
  // access and redirects to the same static/original-file URL new results carry.
  router.get('/stremio/:token/play/:mappingId/:itemId/:mediaSourceId', playbackLimit, async (req, res) => {
    if (!enabled()) return res.status(404).end();
    try {
      const entitlement = await entitlements.findByInstallToken(req.params.token);
      if (!entitlement) return res.status(404).end();
      const mapping = await managedMapping(entitlement.id, req.params.mappingId);
      if (!mapping) return res.status(404).end();
      const household = await claimHouseholdOrReject(entitlement, req, res, 'legacy_managed_playback');
      if (!household) return;
      const target = managedRuntime.directUrl(mapping, req.params.itemId, req.params.mediaSourceId);
      await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES(NULL,'stremio.managed_raw_file.redirected','stremio_entitlement',$1,$2::jsonb)`,
        [entitlement.id, JSON.stringify({ serverId: mapping.server_id, householdDecision: household.decision, compatibilityRoute: true })]
      ).catch(() => {});
      return res.redirect(PLAYBACK_REDIRECT_STATUS, target);
    } catch (error) {
      console.error('Legacy managed Stremio raw-file redirect failed:', safeLogText(error?.message || error, 300));
      return res.status(502).end();
    }
  });

  // Compatibility only for older external stream results. New Stremio results
  // already contain the Jellyfin URL directly.
  router.get('/stremio/:token/external-play/:sourceId/:itemId/:mediaSourceId', playbackLimit, async (req, res) => {
    if (!enabled()) return res.status(404).end();
    try {
      const entitlement = await entitlements.findByInstallToken(req.params.token);
      if (!entitlement) return res.status(404).end();
      const target = await externalRuntime.playbackTargetFor(entitlement, req.params.sourceId, req.params.itemId, req.params.mediaSourceId);
      if (!target) return res.status(404).end();
      const household = await claimHouseholdOrReject(entitlement, req, res, 'legacy_external_playback');
      if (!household) return;
      await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES(NULL,'stremio.external_playback.redirected','stremio_entitlement',$1,$2::jsonb)`,
        [entitlement.id, JSON.stringify({ sourceId: req.params.sourceId, householdDecision: household.decision, compatibilityRoute: true })]
      ).catch(() => {});
      return res.redirect(PLAYBACK_REDIRECT_STATUS, target);
    } catch (error) {
      console.error('External Stremio compatibility redirect failed:', safeLogText(error?.message || error, 300));
      return res.status(502).end();
    }
  });

  // Historical byte-proxy paths remain retired. CAPTAiNFiN authorizes and
  // resolves streams but never receives or relays the media bytes.
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
  deniedStreamResponse,
  claimDirectStreamResult,
  PLAYBACK_REDIRECT_STATUS,
  STREAM_RESULT_CACHE_TTL_MS,
  STREAM_RESULT_CACHE_MAX,
  streamCacheKey,
  cachedStreams,
  rememberStreams,
  clearStreamResultCache,
  createStremioRuntimeRouter
};
