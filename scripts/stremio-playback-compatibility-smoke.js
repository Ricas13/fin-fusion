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

const mapping={media_server_type:'jellyfin',public_url:'https://media.example/jellyfin',base_url:'http://jellyfin:8096/jellyfin',access_token_encrypted:null};
const direct=new URL(managed.directUrl(mapping,'item','source','token','mkv','Movie.2026.1080p.mkv'));
assert.strictEqual(direct.pathname,'/jellyfin/Videos/item/stream.mkv','raw managed Jellyfin playback should preserve the original container extension for player detection');
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

assert.strictEqual(managed.pathExtension('Movie.2026.1080p.mkv'),'mkv');
assert.strictEqual(managed.pathExtension('Movie.2026.1080p.mkv.strm'),'mkv','double-extension STRM paths must preserve the underlying video container');
assert.strictEqual(managed.containerExtension('mkv,webm'),'mkv');
const strmFallback=new URL(managed.directUrl(mapping,'strm-item','strm-source','token','','Movie.2026.1080p.mkv.strm'));
assert.strictEqual(strmFallback.pathname,'/jellyfin/Videos/strm-item/stream.mkv','STRM items without MediaSource.Container must still expose a video extension to Stremio');

assert.strictEqual(typeof external.directPlaybackUrl,'function','external sources must expose a direct raw-file URL builder');

const managedSource=read('src/stremio/managed-runtime.js');
const externalSource=read('src/stremio/external-direct-runtime.js');
const mediaIndexSource=read('src/stremio/media-index.js');
const runtimeSource=read('src/stremio/runtime.js');
const restrictedSource=read('src/stremio/jellyfin-runtime.js');

assert(!managedSource.includes('/PlaybackInfo'),'managed stream discovery must not call PlaybackInfo');
assert(!managedSource.includes("searchParams.set('PlaySessionId'")&&!managedSource.includes("searchParams.set('DeviceId'"),'managed raw-file URLs must not attach playback-session state');
assert(!managedSource.includes('DeviceProfile:'),'managed raw-file delivery must not negotiate a playback device profile');
assert(!managedSource.includes('TranscodingUrl'),'managed Stremio delivery must never switch to a transcoding session');
assert(managedSource.includes("Fields:'Path,MediaSources,MediaStreams'"),'managed stream discovery must resolve media metadata without PlaybackInfo');
assert(managedSource.includes("url.searchParams.set('Static','true')"),'managed playback must return static/original-file URLs');
assert(managedSource.includes('mediaServer.apiPath(type,`/Videos/'),'managed direct URLs must route through the Jellyfin/Emby path adapter');
assert(restrictedSource.includes('registry.mediaProvider.userTokenHeaders')&&restrictedSource.includes('registry.mediaProvider.apiPath'),'restricted metadata requests must use provider-aware user-token headers and paths');
assert(mediaIndexSource.includes('async function lookupAll')&&!mediaIndexSource.includes('item_type=$3 ORDER BY updated_at DESC LIMIT 1'),'managed IMDb lookup must preserve separate media items such as 1080p and 4K copies');
assert(managedSource.includes('mediaIndex.lookupAll(mapping.server_id,args.imdb,args.type)'),'managed result resolution must fan out across every indexed item with the same IMDb id');
assert(managedSource.includes("`${item.id}:${source.Id||'file'}:${filename}`"),'separate items/media sources must keep distinct Stremio binge groups');

assert(!runtimeSource.includes("require('./managed-playback-lifecycle')"),'Stremio runtime must be detached from media-server playback lifecycle reporting');
assert(!runtimeSource.includes('managedPlayback.start(')&&!runtimeSource.includes('managedPlayback.startManager'),'Stremio runtime must never start or maintain provider playback sessions');
assert(!runtimeSource.includes('managedRuntime.playbackInfo'),'managed playback routes must not refresh PlaybackInfo');
assert(runtimeSource.includes('managedRuntime.streamsFor(entitlement, type, videoId)'),'managed stream results must be generated as direct URLs');
assert(runtimeSource.includes('externalRuntime.streamsFor(entitlement, type, videoId)'),'external stream results must also be generated as direct URLs');
assert(runtimeSource.includes("householdAccess.claim(entitlement, req, { kind: 'direct_stream_result' })"),'household admission must be claimed before direct raw URLs are returned');
assert(runtimeSource.includes('managedRuntime.directUrl(mapping, req.params.itemId, req.params.mediaSourceId)'),'legacy managed control URLs must fall through to raw delivery without reporting playback');
assert(!runtimeSource.includes("restrictedPost")&&!runtimeSource.includes("managedPlayback.start("),'runtime must never report a playing session');
assert(!runtimeSource.includes('jellyfinSessionId'),'raw Stremio delivery must not create or audit server session IDs');
assert(!runtimeSource.includes('stream_limit'),'raw Stremio playback must not enforce a concurrent-stream quota');
assert(runtimeSource.includes('CAPTAiNFiN authorizes and')&&runtimeSource.includes('never receives or relays the media bytes'),'CAPTAiNFiN must remain control-plane only');

assert(!externalSource.includes('controlPlaybackUrl'),'external source results must not be wrapped in CAPTAiNFiN playback URLs');
assert(externalSource.includes("url.searchParams.set('Static', 'true')"),'external Jellyfin sources must also return static/original-file URLs');
assert(externalSource.includes('containerExtension(container) || pathExtension(file)'),'external raw URLs must share the same container fallback used for double-extension STRM paths');
assert(!externalSource.includes("searchParams.set('PlaySessionId'")&&!externalSource.includes("searchParams.set('DeviceId'"),'external raw URLs must remain outside playback-session reporting');

console.log('stremio Jellyfin/Emby raw-file playback compatibility smoke: ok');
