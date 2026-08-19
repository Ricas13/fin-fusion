'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const migration=read('db/migrations/016_stremio_managed_source_foundation.sql');
const identities=read('src/stremio/managed-entitlements.js');
const managed=read('src/stremio/managed-runtime.js');
const external=read('src/stremio/external-direct-runtime.js');
const runtime=read('src/stremio/runtime.js');
const customer=read('src/platform/customer-stremio.js');
const jobs=read('src/automation/jobs.js');
const sessions=read('src/stremio/managed-session-reconciler.js');

assert(migration.includes('stremio_managed_accounts'),'managed multi-server identity foundation missing');
assert(identities.includes("account_purpose='stremio_internal'"),'managed playback must use hidden Stremio-only Jellyfin accounts');
assert(identities.includes('MaxActiveSessions:disabled?0:limit'),'hidden managed users must retain Jellyfin-side session limits');
assert(identities.includes('managedSources.enabled()'),'managed identity provisioning must follow managed source configuration');
assert(identities.includes('currentMappings(entitlement.id,allowedIds)'),'normal search reconciliation must have a database-only ready-account fast path');
assert(identities.includes('sources.every(source=>'),'managed search fast path must avoid policy/provisioning work when all mappings are ready');
assert(identities.includes('Promise.allSettled(sources.map'),'missing managed identities should provision concurrently');
assert(identities.includes('revokeInactiveMappings'),'managed direct credentials must be revoked when entitlement/server access ends');
assert(identities.includes('logoutRestrictedToken')&&identities.includes('disableJellyfinAccount'),'revocation must invalidate the token and disable the hidden account');
assert(identities.includes('effective_customer_entitlements')&&identities.includes('effective_customer_addons'),'direct credential revocation must use authoritative effective access state');
assert(customer.includes('preprovisionManaged(issued.credential)'),'Stremio installation should pre-provision managed identities before the first search');
assert(customer.includes('managedEntitlements.revokeInactiveMappings()'),'customer revoke must immediately invalidate direct managed identities');
assert(jobs.includes('async stremio_managed_accounts()')&&jobs.includes('stremioManagedEntitlements.syncActive()'),'automation worker must continuously reconcile managed identities and plan policy');

assert(managed.includes('/PlaybackInfo?'),'managed streams must be resolved through Jellyfin PlaybackInfo');
assert(managed.includes("url.searchParams.set('PlaySessionId'"),'managed direct URL must carry PlaybackInfo PlaySessionId when available');
assert(managed.includes("url.searchParams.set('api_key',token)"),'managed direct URL must use the restricted hidden-user token');
assert(!managed.includes('api_key_encrypted'),'managed runtime must never read the server administrator API key');
assert(!managed.includes('/stremio/${'),'new managed stream URLs must not point at the CAPTAiNFiN byte proxy');
assert(external.includes("url.searchParams.set('api_key',client.sourceToken(source))"),'external direct playback must use its dedicated Jellyfin source token');
assert(!external.includes('/PlaybackInfo'),'external unmanaged streams must not call Jellyfin PlaybackInfo');
assert(!external.includes('PlaySessionId'),'external unmanaged stream URLs must not carry managed playback-session telemetry');
assert(external.includes('/Users/${encodeURIComponent(String(source.jellyfin_user_id))}/Items/'),'external media variants should come from ordinary Jellyfin item metadata, not playback negotiation');
assert(external.includes('MediaSources,MediaStreams'),'external item metadata should preserve the existing quality/result presentation where available');
assert(!external.includes('/stremio/${'),'new external stream URLs must not point at the CAPTAiNFiN byte proxy');
assert(external.includes('Promise.allSettled(sources.map'),'external source resolution must run concurrently');
assert(runtime.includes('Promise.all([')&&runtime.includes('managedRuntime.streamsFor')&&runtime.includes('externalRuntime.streamsFor'),'managed/external resolution must run concurrently');
assert(runtime.includes('const streams=[...managed,...external]'),'managed results must always be emitted before external results');
assert(runtime.includes('Source type/name is never added'),'runtime must preserve source-neutral customer presentation');
assert(runtime.includes('Compatibility-only proxy routes'),'old proxy endpoints may exist only for cached-manifest compatibility');
assert(!managed.includes('source.name')&&!external.includes('source.name'),'customer stream builders must not label results with source names');

assert(sessions.includes("'/Sessions?activeWithinSeconds=180'"),'managed concurrency must observe Jellyfin playback sessions');
assert(sessions.includes('/Playing/Stop'),'managed concurrency must stop visible excess managed sessions');
assert(sessions.includes('active.slice(limit)'),'cross-server reconciliation must preserve only the plan allowance');
assert(sessions.includes('revokeInactiveMappings()'),'session reconciliation cycle must also enforce direct-token lifecycle cleanup');
assert(sessions.includes('new Map(rows.map(row=>[String(row.server_id)'),'managed concurrency must deduplicate Jellyfin servers before polling sessions');
assert(sessions.includes('Promise.allSettled(servers.map(fetchServerSessions))'),'managed concurrency must snapshot each managed server concurrently once per cycle');
assert(!sessions.includes('accounts.map(sessionsFor)'),'managed session polling must not scale by customers × servers');
assert(sessions.includes('snapshotServers(rows)'),'all entitlement reconciliation must reuse one server-session snapshot');
assert(runtime.includes("managedSessions.start({intervalMs:15000})"),'managed session reconciliation must run continuously');

console.log('stremio direct runtime smoke: ok');
