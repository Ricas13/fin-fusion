'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

process.env.STREMIO_RUNTIME_ENABLED='true';
process.env.STREMIO_JELLYFIN_TOKEN_KEY='11'.repeat(32);

const foundation=require('../src/stremio/foundation');
const runtime=require('../src/stremio/runtime');
const jellyfin=require('../src/stremio/jellyfin-runtime');

assert.strictEqual(runtime.available,true,'runtime must advertise its implementation');
assert.strictEqual(foundation.runtimeReady(),true,'runtime must require both enablement and a valid dedicated token key');
const validKey=process.env.STREMIO_JELLYFIN_TOKEN_KEY;
process.env.STREMIO_JELLYFIN_TOKEN_KEY='too-short';
assert.strictEqual(foundation.runtimeReady(),false,'invalid Stremio purpose key must fail closed');
process.env.STREMIO_JELLYFIN_TOKEN_KEY=validKey;

const manifest=runtime.manifest();
assert.deepStrictEqual(manifest.catalogs,[],'CAPTaINFiN must remain a stream-only addon');
assert(manifest.types.includes('movie')&&manifest.types.includes('series'),'manifest must support movie and series streams');
assert(manifest.resources.some(r=>r.name==='stream'),'manifest must expose stream resources');
assert(manifest.resources.find(r=>r.name==='stream').idPrefixes.includes('tt'),'stream IDs must be IMDb-addressable');
assert.strictEqual(manifest.behaviorHints.p2p,false,'CAPTaINFiN streams must not be advertised as P2P');

const filename='Movie.2025.2160p.UHD.BluRay.REMUX.HEVC.DV.HDR.TrueHD.Atmos.7.1-FraMeSToR.strm';
const parsed=foundation.streamDisplayFromFilename(filename);
assert(parsed.name.includes('4K'),'filename fallback must recognise 2160p as 4K');
assert(parsed.description.includes('REMUX')&&parsed.description.includes('HEVC'),'filename fallback must expose source and codec');
assert(parsed.description.includes('Dolby Vision')&&parsed.description.includes('TrueHD Atmos'),'filename fallback must expose dynamic range and audio');
assert(parsed.description.includes('FraMeSToR'),'filename fallback must expose release group');
assert.deepStrictEqual(jellyfin.parseVideoId('movie','tt1234567'),{type:'movie',imdb:'tt1234567'});
assert.deepStrictEqual(jellyfin.parseVideoId('series','tt7654321:2:9'),{type:'series',imdb:'tt7654321',season:2,episode:9});
assert.strictEqual(jellyfin.parseVideoId('series','tt7654321:bad:9'),null);
assert.strictEqual(jellyfin.parseVideoId('movie','tmdb:123'),null,'runtime must not guess unsupported identifier formats');
assert.strictEqual(jellyfin.sourceFilename({path:`/library/${filename}`},{Path:'https://files.example.invalid/opaque?id=123'}),filename,'STRM filename must win over an opaque resolved media URL');
const fourK=jellyfin.sourceQuality({Height:2160,Bitrate:60000000,MediaStreams:[]},filename);
const web1080=jellyfin.sourceQuality({Height:1080,Bitrate:8000000,MediaStreams:[]},'Movie.2025.1080p.WEB-DL.x264-GROUP.strm');
assert.strictEqual(fourK.meta.resolution,'4K');
assert.strictEqual(fourK.meta.source,'REMUX');
assert(fourK.rank>web1080.rank,'4K REMUX must rank above 1080p WEB-DL');

const migration=read('db/migrations/069_stremio_runtime.sql');
for(const fragment of ['account_purpose','stremio_internal','stremio_media_index','jellyfin_access_token_encrypted','Active Stremio entitlement is incomplete'])assert(migration.includes(fragment),`migration missing ${fragment}`);
const entitlement=read('src/stremio/entitlements.js');
assert(entitlement.includes('hashInstallCredential'),'install tokens must be hash-addressed');
assert(entitlement.includes('STREMIO_JELLYFIN_TOKEN_KEY'),'restricted Jellyfin tokens need their own purpose key');
assert(entitlement.includes('MediaBrowser Token'),'restricted playback token must be used as a Jellyfin user bearer, not an administrator API key');
assert(entitlement.includes("account_purpose='stremio_internal'"),'runtime must use dedicated internal Jellyfin identities');
assert(entitlement.includes('effective_customer_entitlements'),'addon bearer lookup must use authoritative effective access/hold state');
assert(entitlement.includes('/Sessions/Logout'),'rotation/revocation must invalidate restricted Jellyfin sessions');
assert(!/SELECT[^;]+api_key_encrypted[^;]+stremio_entitlements/is.test(entitlement),'addon entitlement lookup must not expose administrator Jellyfin keys');

const application=read('src/application.js');
const platformRouter=read('src/platform/router.js');
const runtimeSource=read('src/stremio/runtime.js');
assert(application.includes('createStremioRuntimeRouter'),'application must own the Stremio protocol surface');
assert(application.indexOf('app.use(createStremioRuntimeRouter())')<application.indexOf('app.use(sessionMiddleware())'),'Stremio bearer routes must be mounted before staff/customer sessions');
assert(!platformRouter.includes('createStremioRuntimeRouter'),'platform router must not duplicate the top-level Stremio protocol owner');
assert(runtimeSource.includes("Access-Control-Allow-Origin','*'"),'Stremio protocol endpoints need CORS');
assert(runtimeSource.includes("Cross-Origin-Resource-Policy','cross-origin'"),'global same-origin CORP must be relaxed only on the addon surface');
assert(runtimeSource.includes("scope:'stremio-stream'"),'stream endpoint must be protected by the shared persistent rate limiter');
const streamSource=read('src/stremio/jellyfin-runtime.js');
for(const fragment of ['proxyHeaders','notWebReady','active_playback_sessions'])assert(streamSource.includes(fragment),`stream runtime missing ${fragment}`);
assert(streamSource.includes('mediaIndex.lookup'),'stream runtime must resolve titles through the local media-index boundary');
assert(streamSource.includes('SupportsDirectPlay'),'runtime must prefer direct-play sources rather than becoming a video proxy');
const indexSource=read('src/stremio/media-index.js');
assert(indexSource.includes('stremio_media_index'),'media-index module must own the local IMDb/Jellyfin index table');

const reconciliation=read('src/jellyfin/resilient-provisioning.js');
assert(reconciliation.includes("type==='stremio'")&&reconciliation.includes("type==='bundle'"),'entitlement reconciliation must distinguish delivery types');
assert(reconciliation.includes("account_purpose='jellyfin'"),'normal Jellyfin reconciliation must explicitly preserve a customer-facing identity');
assert(reconciliation.includes('Internal Stremio Jellyfin credentials cannot be changed'),'customer password controls must reject internal Stremio identities');
const dashboard=read('src/platform/customer-dashboard.js');
assert(dashboard.includes("account_purpose='stremio_internal'"),'customer portal must hide internal Stremio Jellyfin identities');
const customerRoute=read('src/platform/customer-stremio.js');
assert(customerRoute.includes("scope:'customer-stremio-install'")&&customerRoute.includes('csrf.verify'),'customer install rotation/revocation must be rate-limited and CSRF protected');
const adminRoute=read('src/platform/admin-stremio.js');
assert(adminRoute.includes('stremio_media_index')&&adminRoute.includes('serviceType'),'admin Stremio control center must expose indexing and delivery type controls');
const compose=read('docker-compose.yml');
const appBlock=compose.slice(compose.indexOf('  app:'),compose.indexOf('  automation-worker:'));
const automationBlock=compose.slice(compose.indexOf('  automation-worker:'),compose.indexOf('  activity-worker:'));
assert(appBlock.includes('STREMIO_JELLYFIN_TOKEN_KEY'),'web runtime requires restricted-token encryption/decryption');
assert(!automationBlock.includes('STREMIO_JELLYFIN_TOKEN_KEY'),'automation indexer must not receive the restricted playback token key');

console.log('stremio runtime smoke: ok');
