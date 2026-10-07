'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

process.env.DATA_ENCRYPTION_KEY=process.env.DATA_ENCRYPTION_KEY||'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY=process.env.JELLYFIN_ENCRYPTION_KEY||'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
process.env.SESSION_SECRET=process.env.SESSION_SECRET||'stremio-playback-compatibility-smoke-session-secret';

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const managed=require('../src/stremio/managed-runtime');
const external=require('../src/stremio/external-direct-runtime');
const sourceClient=require('../src/stremio/source-client');

const mapping={media_server_type:'jellyfin',public_url:'https://media.example/jellyfin',base_url:'http://jellyfin:8096/jellyfin',access_token_encrypted:null};
const direct=new URL(managed.directUrl(mapping,'item','source','token','mkv','Movie.2026.1080p.mkv'));
assert.strictEqual(direct.pathname,'/jellyfin/Videos/item/stream.mkv','raw managed Jellyfin playback must preserve configured reverse-proxy prefixes');
assert.strictEqual(direct.searchParams.get('Static'),'true','managed Stremio must request original/static media bytes');
assert.strictEqual(direct.searchParams.get('MediaSourceId'),'source');
assert.strictEqual(direct.searchParams.get('api_key'),'token');
assert.strictEqual(direct.searchParams.get('PlaySessionId'),null,'raw Stremio URLs must not carry media-server play-session identifiers');
assert.strictEqual(direct.searchParams.get('DeviceId'),null,'raw Stremio URLs must not create playback devices');

const embyMapping={...mapping,media_server_type:'emby',public_url:'https://emby.example'};
const embyDirect=new URL(managed.directUrl(embyMapping,'item','source','emby-user-token','mkv','Movie.2026.1080p.mkv'));
assert.strictEqual(embyDirect.pathname,'/emby/Videos/item/stream.mkv','managed Emby playback must use the Emby API prefix exactly once');
assert.strictEqual(embyDirect.searchParams.get('Static'),'true');
assert.strictEqual(embyDirect.searchParams.get('MediaSourceId'),'source');
assert.strictEqual(embyDirect.searchParams.get('api_key'),'emby-user-token','Stremio direct URLs must carry the restricted Emby user token because the player cannot attach X-Emby-Token headers');
const embyProxyMapping={...embyMapping,public_url:'https://media.example/proxy'};
assert.strictEqual(new URL(managed.directUrl(embyProxyMapping,'item','','token','mkv','x.mkv')).pathname,'/proxy/emby/Videos/item/stream.mkv','managed Emby playback must retain non-Emby reverse-proxy prefixes');
const embyApiRootMapping={...embyMapping,public_url:'https://media.example/proxy/emby'};
assert.strictEqual(new URL(managed.directUrl(embyApiRootMapping,'item','','token','mkv','x.mkv')).pathname,'/proxy/emby/Videos/item/stream.mkv','an Emby API-root URL must not produce a duplicate /emby/emby prefix');

assert.strictEqual(managed.pathExtension('Movie.2026.1080p.mkv'),'mkv');
assert.strictEqual(managed.pathExtension('Movie.2026.1080p.mkv.strm'),'mkv','double-extension STRM paths must preserve the underlying video container');
assert.strictEqual(managed.containerExtension('mkv,webm'),'mkv');
const strmFallback=new URL(managed.directUrl(mapping,'strm-item','strm-source','token','','Movie.2026.1080p.mkv.strm'));
assert.strictEqual(strmFallback.pathname,'/jellyfin/Videos/strm-item/stream.mkv','STRM items without MediaSource.Container must still expose a video extension to Stremio');

assert.strictEqual(typeof external.directPlaybackUrl,'function','external sources must expose a direct raw-file URL builder');
const externalJellyfin={media_server_type:'jellyfin',base_url:'https://fallback.example/jellyfin',access_token_encrypted:sourceClient.encryptToken('durable-source-token')};
const externalJellyfinUrl=new URL(external.directPlaybackUrl({source:externalJellyfin,itemId:'jf-item',mediaSourceId:'jf-media',container:'mkv',filename:'x.mkv',accessToken:'isolated-jellyfin-token'}));
assert.strictEqual(externalJellyfinUrl.pathname,'/jellyfin/Videos/jf-item/stream.mkv','external Jellyfin playback must preserve configured prefixes');
assert.strictEqual(externalJellyfinUrl.searchParams.get('api_key'),'isolated-jellyfin-token','external raw playback must use the explicitly isolated playback token');
assert.notStrictEqual(externalJellyfinUrl.searchParams.get('api_key'),sourceClient.sourceToken(externalJellyfin),'external raw playback must never expose the durable source-maintenance token');
const externalStrmUrl=new URL(external.directPlaybackUrl({source:externalJellyfin,itemId:'strm-item',mediaSourceId:'',container:'',filename:'Movie.2026.1080p.mkv.strm',accessToken:'isolated-jellyfin-token'}));
assert.strictEqual(externalStrmUrl.pathname,'/jellyfin/Videos/strm-item/stream.mkv','external STRM playback must infer the underlying video container when MediaSource.Container is absent');
const externalEmby={media_server_type:'emby',base_url:'https://fallback.example/proxy',access_token_encrypted:sourceClient.encryptToken('durable-emby-source-token')};
const externalEmbyUrl=new URL(external.directPlaybackUrl({source:externalEmby,itemId:'emby-item',mediaSourceId:'emby-media',container:'mkv',filename:'x.mkv',accessToken:'isolated-emby-token'}));
assert.strictEqual(externalEmbyUrl.pathname,'/proxy/emby/Videos/emby-item/stream.mkv','external Emby playback must use the provider adapter and preserve reverse-proxy prefixes');
assert.strictEqual(externalEmbyUrl.searchParams.get('Static'),'true');
assert.strictEqual(externalEmbyUrl.searchParams.get('MediaSourceId'),'emby-media');
assert.strictEqual(externalEmbyUrl.searchParams.get('api_key'),'isolated-emby-token');

const managedSource=read('src/stremio/managed-runtime.js');
const externalSource=read('src/stremio/external-direct-runtime.js');
const mediaIndexSource=read('src/stremio/media-index.js');
const runtimeSource=read('src/stremio/runtime.js');
const restrictedSource=read('src/stremio/jellyfin-runtime.js');
const entitlementSource=read('src/stremio/entitlements.js');
const externalTokenSource=read('src/stremio/external-playback-token.js');
const sourcePoolSource=read('src/stremio/source-pool.js');
const externalTokenMaintenanceSource=read('src/stremio/external-token-maintenance.js');
const sourceClientSource=read('src/stremio/source-client.js');
const tokenAliasMigration=read('db/migrations/20261007182500_stremio_install_token_aliases.sql');

assert(!managedSource.includes('/PlaybackInfo'),'managed stream discovery must not call PlaybackInfo');
assert(!managedSource.includes("searchParams.set('PlaySessionId'")&&!managedSource.includes("searchParams.set('DeviceId'"),'managed raw-file URLs must not attach playback-session state');
assert(!managedSource.includes('DeviceProfile:'),'managed raw-file delivery must not negotiate a playback device profile');
assert(!managedSource.includes('TranscodingUrl'),'managed Stremio delivery must never switch to a transcoding session');
assert(managedSource.includes("Fields:'Path,MediaSources,MediaStreams'"),'managed stream discovery must resolve media metadata without PlaybackInfo');
assert(managedSource.includes("url.searchParams.set('Static','true')"),'managed playback must return static/original-file URLs');
assert(managedSource.includes('mediaServer.apiUrl(base,type,`/Videos/'),'managed direct URLs must route through the prefix-preserving Jellyfin/Emby URL adapter');
assert(restrictedSource.includes('registry.mediaProvider.userTokenHeaders')&&restrictedSource.includes('registry.mediaProvider.apiUrl'),'restricted metadata requests must use provider-aware user-token headers and prefix-preserving URLs');
assert(mediaIndexSource.includes('async function lookupAll')&&!mediaIndexSource.includes('item_type=$3 ORDER BY updated_at DESC LIMIT 1'),'managed IMDb lookup must preserve separate media items such as 1080p and 4K copies');
assert(managedSource.includes('mediaIndex.lookupAll(mapping.server_id,args.imdb,args.type)'),'managed result resolution must fan out across every indexed item with the same IMDb id');
assert(managedSource.includes("`${item.id}:${source.Id||'file'}:${filename}`"),'separate items/media sources must keep distinct Stremio binge groups');

assert(!runtimeSource.includes("require('./managed-playback-lifecycle')"),'Stremio runtime must be detached from media-server playback lifecycle reporting');
assert(!runtimeSource.includes('managedPlayback.start(')&&!runtimeSource.includes('managedPlayback.startManager'),'Stremio runtime must never start or maintain provider playback sessions');
assert(!runtimeSource.includes('managedRuntime.playbackInfo'),'managed playback routes must not refresh PlaybackInfo');
assert(runtimeSource.includes('managedRuntime.streamsFor(entitlement, type, videoId)'),'managed stream results must be generated as direct URLs');
assert(runtimeSource.includes('externalRuntime.streamsFor(entitlement, type, videoId)'),'external stream results must also be generated as direct URLs');
assert(managedSource.includes('mediaIndex.lookupAll(mapping.server_id,args.imdb,args.type)'),'new installation-link issuance must leave managed Jellyfin IMDb lookup/search fan-out unchanged');
assert(externalSource.includes('sourceIndex.lookupAll(source.id,args,args.type)'),'external Jellyfin search must keep IMDb matching while also carrying metadata fallbacks for incomplete provider IDs');
const externalItemsBlock=externalSource.slice(externalSource.indexOf('async function items('),externalSource.indexOf('function mediaSources('));
assert(externalItemsBlock.includes('Promise.allSettled')&&externalItemsBlock.includes('if(found.length)'),'one stale/broken external Jellyfin copy must not erase healthy matching copies from the Stremio result set');
assert(externalItemsBlock.includes('if(failures.length)throw failures[0].reason'),'all-copy external failures must still propagate so authentication/source health is not falsely reported healthy');
assert(externalSource.includes('removeStaleIndexItem(source.id,item.Id)')&&externalSource.includes('Number(error?.status)===404')&&externalSource.includes('item_count=GREATEST(0,item_count-$2)'),'external 404s must prune stale indexed items immediately and keep serving-count metadata aligned');
assert(sourceClientSource.includes("error.code='STREMIO_SOURCE_HTTP'")&&sourceClientSource.includes('error.status=response.status'),'external source HTTP failures must retain status so stale-item 404s are distinguishable from retryable provider failures');
assert(managedSource.includes('mediaIndex.removeItem(mapping.server_id,id)')&&managedSource.includes('Number(error?.status)===404'),'managed 404s must self-heal stale index rows instead of repeating dead results until the periodic rebuild');
assert(mediaIndexSource.includes('async function removeItem(serverId,itemId)')&&mediaIndexSource.includes('item_count=GREATEST(0,item_count-$2)'),'managed stale-index pruning must keep serving-count metadata in sync');
const externalStreamsBlock=externalSource.slice(externalSource.indexOf('async function streamsFor'),externalSource.indexOf('async function playbackTargetFor'));
assert(externalStreamsBlock.indexOf('planExternalSources.forEntitlement(entitlement)')<externalStreamsBlock.indexOf('sourcePool.stremioMeta'),'managed-only plans must never wait on external metadata lookup');
assert(externalStreamsBlock.indexOf('const direct=await resolveSources')<externalStreamsBlock.indexOf('sourcePool.stremioMeta'),'external sources must try their local IMDb index before any metadata fallback');
assert(externalStreamsBlock.includes('direct.missed')&&externalStreamsBlock.includes('fallback.output'),'metadata fallback must retry only external sources that missed the direct indexed lookup');
assert(tokenAliasMigration.includes('token_hash_aliases text[]')&&tokenAliasMigration.includes('USING gin (token_hash_aliases)'),'automatic link recovery must preserve hashed aliases without storing another plaintext install token');
assert(entitlementSource.includes("COALESCE(e.token_hash_aliases,'{}'::text[]) @> ARRAY[$1]::text[]"),'active addon lookup must accept an automatically-preserved previous install token so existing Stremio installs keep returning Jellyfin results');
assert(runtimeSource.includes("COALESCE(e.token_hash_aliases,'{}'::text[]) @> ARRAY[$1]::text[]"),'subscription-ended runtime lookup must recognize preserved install-token aliases too');
const ensureBlock=entitlementSource.slice(entitlementSource.indexOf('async function ensureInstallationCredential'),entitlementSource.indexOf('function activatedOutcome'));
assert(ensureBlock.includes('const nextAliases=rotate?[]:[')&&ensureBlock.includes('].slice(-4);')&&ensureBlock.includes('SET token_hash_aliases=$5::text[]'),'automatic recovery must preserve only a bounded set of same-term installed-token aliases while explicit rotation clears them');
assert(ensureBlock.includes("if(rotate&&Array.isArray(row.token_hash_aliases)&&row.token_hash_aliases.length)")&&ensureBlock.includes("SET token_hash_aliases='{}'::text[]"),'rapid duplicate explicit rotation must clear automatic-recovery aliases even when it reuses the just-issued credential');
assert(entitlementSource.includes("token_hash_aliases='{}'::text[]")&&entitlementSource.includes("last_error='Stremio revocation cleanup pending.'"),'explicit revoke must clear historical install-token aliases before cleanup so revoked links cannot remain recognizable');
for(const forbidden of ['stremio_media_index','stremio_source_media_index','plan_stremio_sources','sourceIndex','mediaIndex'])assert(!ensureBlock.includes(forbidden),`installation-link issuance must not mutate or depend on Jellyfin/Stremio search state: ${forbidden}`);
assert(runtimeSource.includes("householdAccess.claim(entitlement, req, { kind: 'direct_stream_result' })"),'household admission must be claimed before direct raw URLs are returned');
assert(runtimeSource.includes('managedRuntime.directUrl(mapping, req.params.itemId, req.params.mediaSourceId)'),'legacy managed control URLs must fall through to raw delivery without reporting playback');
assert(!runtimeSource.includes("restrictedPost")&&!runtimeSource.includes("managedPlayback.start("),'runtime must never report a playing session');
assert(!runtimeSource.includes('jellyfinSessionId'),'raw Stremio delivery must not create or audit server session IDs');
assert(!runtimeSource.includes('stream_limit'),'raw Stremio playback must not enforce a concurrent-stream quota');
assert(runtimeSource.includes('CAPTAiNFiN authorizes and')&&runtimeSource.includes('never receives or relays the media bytes'),'CAPTAiNFiN must remain control-plane only');

assert(!externalSource.includes('controlPlaybackUrl'),'external source results must not be wrapped in CAPTAiNFiN playback URLs');
assert(/url\.searchParams\.set\(\s*['"]Static['"]\s*,\s*['"]true['"]\s*\)/.test(externalSource),'external sources must return static/original-file URLs');
assert(externalSource.includes('client.sourceUrl(source.base_url')&&externalSource.includes('source.media_server_type'),'external direct URLs must route through the stored provider type');
assert(!externalSource.includes('client.sourceToken(source)'),'external raw-file URLs must never decrypt the durable source token for playback');
assert(externalSource.includes('externalPlaybackToken.tokenFor(source,entitlement,{returnContext:true})'),'external raw-file URLs must be issued with isolated per-entitlement playback sessions and receive the locked current source context');
assert(!externalSource.includes("searchParams.set('PlaySessionId'")&&!externalSource.includes("searchParams.set('DeviceId'"),'external raw URLs must remain outside playback-session reporting');
assert(!externalSource.includes('/Sessions/Playing')&&!externalSource.includes('/Sessions/Playing/Progress')&&!externalSource.includes('/Sessions/Playing/Stopped'),'external fallback playback must not manufacture media-server playback reporting');

assert(externalTokenSource.includes('async function revokeEntitlement(entitlementId)'),'isolated raw sessions must support synchronous per-entitlement revocation');
assert(externalTokenSource.includes('async function currentlyDue(row)')&&externalTokenSource.includes('operationLock.withLock(`external-playback:${row.source_id}:${row.entitlement_id}`'),'background raw-token expiry cleanup must share the same per-session serialization lock as token issuance');
assert(externalTokenSource.includes('operationLock.withLock(`stremio-plan:${planId}`')&&externalTokenSource.includes('async function sourceAuthorized(sourceId,entitlementId'),'raw playback issuance must serialize with plan-source authorization changes and revalidate the selected source');
assert(externalTokenSource.includes('operationLock.withLock(`external-token:${source.id}`'),'raw playback issuance must also serialize with source disable/reconnect/token-identity mutations so a fresh session cannot be minted after source revocation begins');
assert(externalTokenSource.includes('const latestSource=await currentSource(source.id)')&&externalTokenSource.includes('source=latestSource'),'raw playback issuance must refresh the external source row after acquiring its source lock so a request waiting behind reconnect cannot authenticate with stale source state');
assert(externalSource.includes('returnContext:true')&&externalSource.includes('source:currentSource')&&externalSource.includes('if(sourceChanged){found=await items(currentSource,args)'),'external raw stream URLs must be built from the locked current source and must re-resolve media if reconnect changed source identity/config while the request was waiting');
assert((externalTokenSource.match(/sourceAuthorized\(source\.id,entitlement\.id\)/g)||[]).length>=2,'raw playback issuance must re-check source authorization before reuse/authentication and again before committing a newly-authenticated session');
assert(externalTokenSource.includes('const latest = await current(row.source_id, row.entitlement_id)')&&externalTokenSource.includes('!await currentlyDue(latest)'),'expiry cleanup must re-read and revalidate the current session after acquiring its lock so it cannot revoke a freshly renewed token');
const reconnectBlock=sourcePoolSource.slice(sourcePoolSource.indexOf('async function reconnect'),sourcePoolSource.indexOf('async function rotateSourceToken'));
assert(reconnectBlock.indexOf('await externalPlaybackToken.revokeSource(sourceId)')>=0&&reconnectBlock.indexOf('await externalPlaybackToken.revokeSource(sourceId)')<reconnectBlock.indexOf('UPDATE stremio_sources SET base_url='),'source reconnect must revoke isolated raw playback sessions before changing source identity/base URL');
const rotateBlock=externalTokenMaintenanceSource.slice(externalTokenMaintenanceSource.indexOf('async function rotateSourceToken'),externalTokenMaintenanceSource.indexOf('async function rotateDueTokens'));
assert(rotateBlock.includes("String(auth.jellyfinUserId)!==String(current.jellyfin_user_id)")&&rotateBlock.includes("error.code='STREMIO_SOURCE_IDENTITY_CHANGED'"),'automatic source-token rotation must fail closed instead of silently switching the configured Jellyfin/Emby user identity');
assert((entitlementSource.match(/externalPlaybackToken\.revokeEntitlement\(row\.id\)/g)||[]).length>=2,'both Stremio suspension and explicit revocation must synchronously revoke isolated external playback sessions');
assert(entitlementSource.includes("SET status=CASE WHEN status='revoked' THEN status ELSE 'suspended' END")&&entitlementSource.includes("SET status='suspended',token_hash=NULL"),'Stremio access must become non-active before external session cleanup so a racing stream request cannot mint a replacement token');

console.log('stremio Jellyfin/Emby raw-file playback compatibility smoke: ok');
