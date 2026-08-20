'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

process.env.STREMIO_RUNTIME_ENABLED='true';
process.env.STREMIO_JELLYFIN_TOKEN_KEY='11'.repeat(32);
process.env.JELLYFIN_ENCRYPTION_KEY='22'.repeat(32);

const foundation=require('../src/stremio/foundation');
const runtime=require('../src/stremio/runtime');
const jellyfin=require('../src/stremio/jellyfin-runtime');

assert.strictEqual(runtime.available,true,'runtime must advertise its implementation');
assert.strictEqual(foundation.runtimeReady(),true,'legacy enablement must remain compatible until browser-managed state is loaded');
const manifest=runtime.manifest();
assert.equal(manifest.name,'CAPTAiNFiN');
assert.deepStrictEqual(manifest.catalogs,[],'CAPTAiNFiN must remain a stream-only addon');
assert(manifest.types.includes('movie')&&manifest.types.includes('series'),'manifest must support movie and series streams');
assert(manifest.resources.some(r=>r.name==='stream'),'manifest must expose stream resources');
assert(manifest.resources.find(r=>r.name==='stream').idPrefixes.includes('tt'),'stream IDs must be IMDb-addressable');
assert.strictEqual(manifest.behaviorHints.p2p,false,'CAPTAiNFiN streams must not be advertised as P2P');

const filename='Movie.2025.2160p.UHD.BluRay.REMUX.HEVC.DV.HDR.TrueHD.Atmos.7.1-FraMeSToR.strm';
const parsed=foundation.streamDisplayFromFilename(filename);
assert(parsed.name.includes('4K')&&parsed.description.includes('REMUX')&&parsed.description.includes('HEVC'));
assert(parsed.description.includes('Dolby Vision')&&parsed.description.includes('TrueHD Atmos')&&parsed.description.includes('FraMeSToR'));
assert.deepStrictEqual(jellyfin.parseVideoId('movie','tt1234567'),{type:'movie',imdb:'tt1234567'});
assert.deepStrictEqual(jellyfin.parseVideoId('series','tt7654321:2:9'),{type:'series',imdb:'tt7654321',season:2,episode:9});
assert.strictEqual(jellyfin.parseVideoId('series','tt7654321:bad:9'),null);
assert.strictEqual(jellyfin.parseVideoId('movie','tmdb:123'),null);

const entitlement=read('src/stremio/entitlements.js');
const managedAccounts=read('src/stremio/managed-entitlements.js');
const managedRuntime=read('src/stremio/managed-runtime.js');
const externalRuntime=read('src/stremio/external-direct-runtime.js');
const runtimeSource=read('src/stremio/runtime.js');
const sourcePool=read('src/stremio/source-pool.js');
const sourceClient=read('src/stremio/source-client.js');
const sourceIndex=read('src/stremio/source-index.js');
const sourceAdmission=read('src/stremio/source-admission.js');
const managedSessions=read('src/stremio/managed-session-reconciler.js');
const matchMigration=read('db/migrations/003_stremio_source_match_fallbacks.sql');
const managedLeaseMigration=read('db/migrations/011_stremio_managed_playback_leases.sql');

assert(entitlement.includes('plan_stremio_sources')&&entitlement.includes('reconcileSharedForCustomer'),'legacy/source-only entitlement compatibility must remain available');
assert(entitlement.includes('STREMIO_JELLYFIN_TOKEN_KEY'),'restricted managed tokens must remain purpose-separated');
assert(entitlement.includes("account_purpose='stremio_internal'"),'managed path must retain internal Jellyfin identity isolation');
assert(entitlement.includes('effective_customer_entitlements'),'addon bearer lookup must use authoritative effective access state');
assert(!/SELECT[^;]+api_key_encrypted[^;]+stremio_entitlements/is.test(entitlement),'addon entitlement lookup must never expose administrator Jellyfin keys');
assert(managedAccounts.includes('stremio_managed_accounts'),'managed entitlements must support one hidden account per managed server');
assert(managedAccounts.includes('MaxActiveSessions:disabled?0:limit'),'each hidden managed account must receive the plan stream limit as Jellyfin defense in depth');

assert(runtimeSource.includes('managedRuntime.streamsFor')&&runtimeSource.includes('externalRuntime.streamsFor'),'runtime must use the managed and external source resolvers');
assert(runtimeSource.includes('const streams=[...managed,...external]'),'managed sources must be returned before external sources');
assert(runtimeSource.includes('Promise.all(['),'managed and external source classes should resolve concurrently');
assert(managedRuntime.includes('/PlaybackInfo?'),'managed results must use PlaybackInfo');
assert(managedRuntime.includes("url.searchParams.set('api_key',token)"),'managed direct playback must use the restricted hidden-user token');
assert(!managedRuntime.includes('api_key_encrypted'),'managed direct playback must never expose administrator Jellyfin API-key storage');
assert(externalRuntime.includes("url.searchParams.set('api_key',client.sourceToken(source))"),'external unmanaged results must resolve to their direct Jellyfin URL');
assert(externalRuntime.includes('/Videos/${encodeURIComponent(item)}/stream'),'external unmanaged results must point directly to Jellyfin media delivery');
assert(externalRuntime.includes('Promise.allSettled(sources.map'),'external sources must be queried concurrently rather than serially');
assert(!managedRuntime.includes('source.name')&&!externalRuntime.includes('source.name'),'customer stream presentation must remain source-neutral');

assert(managedSessions.includes("'/Sessions?activeWithinSeconds=180'"),'managed concurrency must observe Jellyfin sessions across the fleet');
assert(managedSessions.includes('/Playing/Stop'),'managed concurrency must be able to stop excess Jellyfin sessions');
assert(managedSessions.includes('active.slice(limit)'),'managed concurrency must preserve only the plan stream allowance');
assert(runtimeSource.includes("managedSessions.start({intervalMs:15000})"),'cross-server managed concurrency reconciliation must run continuously');

// CAPTAiNFiN is strictly the managed Stremio control plane. It may authorize
// and redirect managed playback, but it must never relay media bytes. External
// fallback results bypass CAPTAiNFiN playback entirely.
assert(runtimeSource.includes('/stremio/:token/play/:mappingId/:itemId/:mediaSourceId'),'managed playback control route must remain available');
assert(runtimeSource.includes('res.redirect(307,target.url)'),'managed playback control must redirect to Jellyfin after admission');
assert(runtimeSource.includes("require('./source-admission')")&&runtimeSource.includes('sourceAdmission.admit'),'managed playback must retain serialized CAPTAiNFiN admission');
assert(sourceAdmission.includes('FOR UPDATE')&&sourceAdmission.includes('stream_limit')&&sourceAdmission.includes('active>=limit'),'managed admission must remain race-safe');
assert(sourceAdmission.includes('LEASE_SECONDS=150'),'managed admission leases must remain short-lived until lifecycle renewal');
assert(managedLeaseMigration.includes('ALTER COLUMN source_id DROP NOT NULL'),'managed playback leases must remain representable without an external source id');
assert(!runtimeSource.includes("require('./source-playback')")&&!runtimeSource.includes('sourcePlayback.open'),'runtime must not own a raw upstream playback boundary');
assert(!runtimeSource.includes('upstream.pipe(res)')&&!runtimeSource.includes('pipePlayback('),'runtime must never pipe media responses through CAPTAiNFiN');
assert(runtimeSource.includes('/stremio/:token/source/:sourceId/:itemId/:mediaSourceId')&&runtimeSource.includes('/stremio/:token/jellyfin/:itemId/:mediaSourceId'),'historical cached proxy URLs should remain recognizable only to fail closed');
assert(runtimeSource.includes('res.status(410).end()'),'historical proxy URLs must return Gone rather than relay media');
assert(!externalRuntime.includes('sourceAdmission')&&!externalRuntime.includes('/stremio/'),'external fallback results must not use CAPTAiNFiN admission or playback URLs');

assert(sourceClient.includes("TOKEN_ENV='JELLYFIN_ENCRYPTION_KEY'"),'external Jellyfin tokens must use the platform Jellyfin encryption key');
assert(sourceClient.includes('/Users/AuthenticateByName'),'external sources must authenticate as normal Jellyfin users');
assert(sourceIndex.includes('MinDateLastSaved')&&sourceIndex.includes('INCREMENTAL_HOURS=6')&&sourceIndex.includes('FULL_RECONCILE_DAYS=7'),'source indexing must be incremental with periodic reconciliation');
assert(sourceIndex.includes('tmdb_id')&&sourceIndex.includes('tvdb_id')&&sourceIndex.includes('title_key'),'source index must retain alternate metadata IDs and normalized title keys');
assert(sourcePool.includes('sourceIndex.lookupAll'),'legacy source resolver must retain indexed lookup support');
assert(matchMigration.includes('ALTER COLUMN imdb_id DROP NOT NULL')&&matchMigration.includes('stremio_source_media_tmdb_idx')&&matchMigration.includes('stremio_source_media_title_idx'),'metadata fallback migration must keep alternate lookup indexes');

const migration=read('db/migrations/000_database_baseline.sql');
for(const fragment of ['stremio_source_libraries','stremio_source_media_index','stremio_source_index_state','plan_stremio_sources','stremio_source_playback_leases'])assert(migration.includes(fragment),`source catalog migration missing ${fragment}`);
assert(migration.includes('selected shared sources or a managed Jellyfin delivery identity'),'database must preserve legacy/source-only entitlement compatibility');

const application=read('src/application.js'),platformRouter=read('src/platform/router.js');
assert(application.includes('createStremioRuntimeRouter')&&application.indexOf('app.use(createStremioRuntimeRouter())')<application.indexOf('app.use(sessionMiddleware())'),'Stremio bearer runtime must remain outside staff/customer session middleware');
assert(!platformRouter.includes('createStremioRuntimeRouter'),'platform router must not duplicate protocol ownership');
assert(runtimeSource.includes("Access-Control-Allow-Origin','*'")&&runtimeSource.includes("Cross-Origin-Resource-Policy','cross-origin'"),'Stremio protocol surface needs its scoped cross-origin policy');
assert(runtimeSource.includes('runtimeSettings.ensureLoaded()')&&!runtimeSource.includes('process.env.STREMIO_RUNTIME_ENABLED'),'protocol endpoints must use persisted runtime settings');

const reconciliation=read('src/jellyfin/resilient-provisioning.js');
assert(reconciliation.includes("account_purpose='jellyfin'"),'normal Jellyfin reconciliation must preserve customer-facing identities');
assert(reconciliation.includes('Internal Stremio Jellyfin credentials cannot be changed'),'customer password controls must reject internal identities');
const dashboard=read('src/platform/customer-dashboard.js');
assert(dashboard.includes("account_purpose='stremio_internal'"),'customer portal must hide internal Stremio identities');
const customerRoute=read('src/platform/customer-stremio.js');
assert(customerRoute.includes("scope:'customer-stremio-install'")&&customerRoute.includes('csrf.verify'),'customer install mutation must remain rate-limited and CSRF protected');

console.log('stremio runtime smoke: ok');
