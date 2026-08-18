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
assert(entitlement.includes('plan_stremio_sources')&&entitlement.includes('reconcileSharedForCustomer'),'runtime must support source-only Stremio entitlements');
assert(entitlement.includes('server_id=NULL')&&entitlement.includes('jellyfin_account_id=NULL'),'shared-source entitlements must not require a managed hidden Jellyfin identity');
assert(entitlement.includes('STREMIO_JELLYFIN_TOKEN_KEY'),'legacy managed restricted-token path must remain supported');
assert(entitlement.includes("account_purpose='stremio_internal'"),'legacy managed path must retain internal Jellyfin identity isolation');
assert(entitlement.includes('effective_customer_entitlements'),'addon bearer lookup must use authoritative effective access state');
assert(!/SELECT[^;]+api_key_encrypted[^;]+stremio_entitlements/is.test(entitlement),'addon entitlement lookup must never expose administrator Jellyfin keys');

const runtimeSource=read('src/stremio/runtime.js');
const sourcePool=read('src/stremio/source-pool.js');
const sourceClient=read('src/stremio/source-client.js');
const sourceIndex=read('src/stremio/source-index.js');
const sourcePlayback=read('src/stremio/source-playback.js');
const sourceAdmission=read('src/stremio/source-admission.js');
const matchMigration=read('db/migrations/003_stremio_source_match_fallbacks.sql');
assert(runtimeSource.includes('/stremio/:token/source/:sourceId/:itemId/:mediaSourceId'),'external source media proxy fallback route must remain available');
assert(runtimeSource.includes('authorizedSourceForEntitlement'),'proxy requests must re-check the plan/customer source allow-list');
assert(runtimeSource.includes("scope:'stremio-source-playback'"),'external playback proxy must be rate limited');
assert(runtimeSource.includes("require('./source-playback')")&&runtimeSource.includes('sourcePlayback.open'),'runtime must use the dedicated raw source playback boundary');
assert(runtimeSource.includes("require('./source-admission')")&&runtimeSource.includes('sourceAdmission.issue()')&&runtimeSource.includes('sourceAdmission.admit'),'external source playback must enforce a CAPTAiNFiN concurrency lease');
assert(runtimeSource.includes('function attachLease(streams,lease=sourceAdmission.issue())')&&runtimeSource.includes('if(streams.length)streams=attachLease(streams)'),'alternate releases from one stream lookup must share one playback lease');
assert(runtimeSource.includes('releaseSoon')&&runtimeSource.includes('setTimeout(()=>sourceAdmission.release(e.id,lease).catch(()=>{}),5000)'),'closed Stremio probe/playback requests must release their lease quickly');
assert(runtimeSource.includes("res.status(429)")&&runtimeSource.includes('sourceAdmission.touch'),'over-limit playback must fail closed and live streams must refresh their leases');
assert(sourceAdmission.includes('FOR UPDATE')&&sourceAdmission.includes('stream_limit')&&sourceAdmission.includes('active>=limit'),'external concurrency admission must serialize per entitlement and enforce the plan stream limit');
assert(sourceAdmission.includes('LEASE_SECONDS=150')&&sourceAdmission.includes('SET source_id=$3,item_id=$4'),'playback leases must be short-lived and reusable across alternate releases from one stream lookup');
assert(sourcePlayback.includes('assertSafeIntegrationUrl')&&sourcePlayback.includes('client.sourceUrl'),'upstream proxy must retain outbound URL/DNS safety and Jellyfin base-path handling');
assert(sourcePool.includes("STREMIO_SOURCE_DIRECT_PLAYBACK||'true'")&&sourcePool.includes("url.searchParams.set('api_key',client.sourceToken(source))"),'manual Stremio source streams must default to direct token-visible Jellyfin playback');
assert(sourcePool.includes('return `${String(proxyBase')&&sourcePool.includes("STREMIO_SOURCE_DIRECT_PLAYBACK||'true'"),'manual source playback must retain the CAPTAiNFiN proxy fallback when direct mode is disabled');
assert(sourcePool.includes('sourceIndex.lookupAll')&&sourcePool.includes('selectionMode:\'all_available_releases\''),'manual Stremio sources must return every indexed release instead of collapsing Movies and Movies-4K to one stream');
assert(sourcePool.includes('streamDisplayFromFilename')&&sourcePool.includes('📺 ${video.DisplayTitle}')&&sourcePool.includes('📶 ${(Number(media.Bitrate)/1000000).toFixed(1)} Mbps'),'external stream cards must keep useful filename-derived release details');
assert(!sourcePool.includes('📁 ${filename}')&&!sourcePool.includes('🗂️ ${libraryName')&&!sourcePool.includes('Jellyfin source`'),'external stream cards must not expose source names, library names, or folder/file names');
assert(sourceClient.includes("TOKEN_ENV='JELLYFIN_ENCRYPTION_KEY'"),'external Jellyfin tokens must use the platform Jellyfin encryption key');
assert(sourceClient.includes('/Users/AuthenticateByName'),'external sources must authenticate as normal Jellyfin users');
assert(sourceIndex.includes('MinDateLastSaved')&&sourceIndex.includes('INCREMENTAL_HOURS=6')&&sourceIndex.includes('FULL_RECONCILE_DAYS=7'),'source indexing must be incremental with periodic reconciliation');
assert(sourceIndex.includes('tmdb_id')&&sourceIndex.includes('tvdb_id')&&sourceIndex.includes('title_key'),'source index must store alternate metadata IDs and normalized title keys');
assert(sourcePool.includes('v3-cinemeta.strem.io')&&sourcePool.includes('stremioMeta')&&sourcePool.includes('sourceIndex.lookupAll(source.id,identity,type)'),'manual source resolution must use Stremio metadata for non-IMDb fallback matching');
assert(matchMigration.includes('ALTER COLUMN imdb_id DROP NOT NULL')&&matchMigration.includes('stremio_source_media_tmdb_idx')&&matchMigration.includes('stremio_source_media_title_idx'),'metadata fallback migration must make IMDb optional and index alternate lookup fields');

const migration=read('db/migrations/000_database_baseline.sql');
for(const fragment of ['stremio_source_libraries','stremio_source_media_index','stremio_source_index_state','plan_stremio_sources','stremio_source_playback_leases'])assert(migration.includes(fragment),`source catalog migration missing ${fragment}`);
assert(migration.includes('selected shared sources or a managed Jellyfin delivery identity'),'database must permit source-only entitlements while preserving legacy integrity');

const application=read('src/application.js'),platformRouter=read('src/platform/router.js');
assert(application.includes('createStremioRuntimeRouter')&&application.indexOf('app.use(createStremioRuntimeRouter())')<application.indexOf('app.use(sessionMiddleware())'),'Stremio bearer runtime must remain outside staff/customer session middleware');
assert(!platformRouter.includes('createStremioRuntimeRouter'),'platform router must not duplicate protocol ownership');
assert(runtimeSource.includes("Access-Control-Allow-Origin','*'")&&runtimeSource.includes("Cross-Origin-Resource-Policy','cross-origin'"),'Stremio protocol surface needs its scoped cross-origin policy');
assert(runtimeSource.includes('runtimeSettings.ensureLoaded()')&&!runtimeSource.includes('process.env.STREMIO_RUNTIME_ENABLED'),'protocol endpoints must use persisted runtime settings');

const reconciliation=read('src/jellyfin/resilient-provisioning.js');
assert(reconciliation.includes("account_purpose='jellyfin'"),'normal Jellyfin reconciliation must preserve customer-facing identities');
assert(reconciliation.includes('Internal Stremio Jellyfin credentials cannot be changed'),'customer password controls must reject legacy internal identities');
const dashboard=read('src/platform/customer-dashboard.js');
assert(dashboard.includes("account_purpose='stremio_internal'"),'customer portal must hide legacy internal Stremio identities');
const customerRoute=read('src/platform/customer-stremio.js');
assert(customerRoute.includes("scope:'customer-stremio-install'")&&customerRoute.includes('csrf.verify'),'customer install mutation must remain rate-limited and CSRF protected');

console.log('stremio runtime smoke: ok');
