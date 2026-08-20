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
const lifecycle=require('../src/stremio/managed-playback-lifecycle');
const admission=require('../src/stremio/source-admission');

const profile=managed.stremioDeviceProfile();
assert(profile.DirectPlayProfiles.some(row=>row.Type==='Video'&&row.VideoCodec==='h264'),'managed Stremio profile must direct-play broadly compatible H.264 video');
assert(profile.TranscodingProfiles.some(row=>row.Type==='Video'&&row.Protocol==='hls'&&row.Container==='ts'&&row.VideoCodec==='h264'),'managed Stremio profile must offer HLS H.264 compatibility transcoding');
assert.strictEqual(managed.playMethodFor({Id:'a',SupportsDirectPlay:true}),'DirectPlay');
assert.strictEqual(managed.playMethodFor({Id:'a',SupportsDirectPlay:false,SupportsDirectStream:true,TranscodingUrl:'/videos/a/master.m3u8'}),'DirectStream');
assert.strictEqual(managed.playMethodFor({Id:'a',SupportsDirectPlay:false,SupportsDirectStream:false,SupportsTranscoding:true,TranscodingUrl:'/videos/a/master.m3u8'}),'Transcode');
assert.strictEqual(managed.playMethodFor({Id:'a',SupportsDirectPlay:false,SupportsDirectStream:false,SupportsTranscoding:false}),'DirectPlay','plans that forbid conversion must retain optimistic native-player direct fallback');

const mapping={public_url:'https://media.example/jellyfin',base_url:'http://jellyfin:8096/jellyfin',access_token_encrypted:null};
const direct=new URL(managed.directUrl(mapping,'item','source','play','device','token','mkv'));
assert.strictEqual(direct.pathname,'/jellyfin/Videos/item/stream.mkv','direct playback should preserve the original container extension for player detection');
assert.strictEqual(direct.searchParams.get('Static'),'true');
assert.strictEqual(direct.searchParams.get('api_key'),'token');
assert.strictEqual(direct.searchParams.get('PlaySessionId'),'play');
assert.strictEqual(direct.searchParams.get('DeviceId'),'device');

const transcoded=new URL(managed.publicTranscodingUrl(mapping,'/jellyfin/videos/item/master.m3u8?api_key=old&VideoCodec=h264',{accessToken:'fresh',playSessionId:'play2',deviceId:'device2'}));
assert.strictEqual(transcoded.origin,'https://media.example');
assert.strictEqual(transcoded.pathname,'/jellyfin/videos/item/master.m3u8');
assert.strictEqual(transcoded.searchParams.get('api_key'),'fresh','persistent PlaybackInfo token must be replaced by the admitted per-playback token');
assert.strictEqual(transcoded.searchParams.get('PlaySessionId'),'play2');
assert.strictEqual(transcoded.searchParams.get('DeviceId'),'device2');

assert.strictEqual(lifecycle.playbackBody({itemId:'i',mediaSourceId:'m',playSessionId:'p',playMethod:'Transcode'}).PlayMethod,'Transcode','Jellyfin lifecycle reporting must match the negotiated play method');
assert.strictEqual(lifecycle.SESSION_ACTIVE_SECONDS,20,'background managed playback liveness must stay short');
assert.strictEqual(lifecycle.ADMISSION_ACTIVE_SECONDS,5,'blocked admission must use a five-second live-session recheck');
assert.strictEqual(lifecycle.START_GRACE_SECONDS,10,'startup grace must not hold a stopped slot for tens of seconds');
const now=Date.now();
assert(lifecycle.sessionFresh({NowPlayingItem:{Id:'i'},LastActivityDate:new Date(now-4000).toISOString()},now,5),'recent managed playback must remain active');
assert(!lifecycle.sessionFresh({NowPlayingItem:{Id:'i'},LastActivityDate:new Date(now-6000).toISOString()},now,5),'silent managed playback must become stale within the admission window');
assert.strictEqual(admission.cleanMetadata({playMethod:'DirectStream'}).playMethod,'DirectStream');
assert.strictEqual(admission.cleanMetadata({playMethod:'anything'}).playMethod,null,'lease metadata must reject unknown play methods');

const managedSource=read('src/stremio/managed-runtime.js');
const mediaIndexSource=read('src/stremio/media-index.js');
const runtimeSource=read('src/stremio/runtime.js');
const lifecycleSource=read('src/stremio/managed-playback-lifecycle.js');
const reconcilerSource=read('src/stremio/managed-session-reconciler.js');
const migration=read('db/migrations/019_stremio_managed_play_method.sql');
assert(managedSource.includes("{method:'POST',body}"),'managed PlaybackInfo must send a device profile in a POST body');
assert(managedSource.includes('DeviceProfile:stremioDeviceProfile()'),'managed PlaybackInfo must declare Stremio playback capabilities');
assert(managedSource.includes('source.TranscodingUrl'),'managed playback must honor Jellyfin compatibility URLs instead of forcing Static direct play');
assert(mediaIndexSource.includes('async function lookupAll')&&!mediaIndexSource.includes('item_type=$3 ORDER BY updated_at DESC LIMIT 1'),'managed IMDb lookup must preserve separate Jellyfin items such as 1080p and 4K copies');
assert(managedSource.includes('mediaIndex.lookupAll(mapping.server_id,args.imdb,args.type)'),'managed result resolution must fan out across every indexed item with the same IMDb id');
assert(managedSource.includes('`${item.id}:${source.Id}:${filename}`'),'separate Jellyfin items/media sources must keep distinct Stremio binge groups');
assert(runtimeSource.includes('managedRuntime.playbackInfo(mapping,req.params.itemId,req.params.mediaSourceId)'),'playback admission must refresh the selected media-source negotiation');
assert(runtimeSource.includes("admission.reason==='stream_limit'")&&runtimeSource.includes('managedPlayback.reconcileEntitlement(e.id)'),'a blocked managed play must re-check stale Jellyfin sessions before returning 429');
assert(runtimeSource.includes("managedSessions.start({intervalMs:5000})")&&runtimeSource.includes("managedPlayback.startManager({intervalMs:5000})"),'managed Stremio reconciliation must run every five seconds');
assert(!runtimeSource.includes('jellyfin.startStreamManager'),'the retired single-entitlement stream manager must not run alongside the multi-server reconciler');
assert(reconcilerSource.includes('managedPlayback.ADMISSION_ACTIVE_SECONDS'),'managed concurrency enforcement must use the same live-session window as admission rechecks');
assert(runtimeSource.includes('res.redirect(307,target.url)'),'managed playback must remain no-byte direct delivery while preserving request semantics across the Jellyfin redirect');
assert(runtimeSource.includes('playMethod:target.playMethod'),'managed admission audit must record the actual delivery method');
assert(lifecycleSource.includes("playMethod:row.play_method||'DirectPlay'"),'managed stop reporting must reuse the negotiated play method');
assert(lifecycleSource.includes('failedServerIds')&&lifecycleSource.includes("snapshot.failedServerIds.has(String(row.server_id))"),'managed admission rechecks must fail closed when Jellyfin session snapshots fail');
assert(lifecycleSource.includes("if(!row.jellyfin_session_id&&started&&now-started<START_GRACE_SECONDS*1000)continue"),'startup grace must only protect a playback whose Jellyfin session has not resolved yet');
assert(lifecycleSource.includes("sourceAdmission.touchHash(row.lease_hash,{seconds:SESSION_ACTIVE_SECONDS})"),'fail-closed session checks must retain the managed admission lease');
assert(migration.includes('play_method')&&migration.includes("'DirectStream'")&&migration.includes("'Transcode'"),'managed playback migration must persist the negotiated Jellyfin play method');

console.log('stremio playback compatibility smoke: ok');
