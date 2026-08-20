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
assert.strictEqual(admission.cleanMetadata({playMethod:'DirectStream'}).playMethod,'DirectStream');
assert.strictEqual(admission.cleanMetadata({playMethod:'anything'}).playMethod,null,'lease metadata must reject unknown play methods');

const managedSource=read('src/stremio/managed-runtime.js');
const runtimeSource=read('src/stremio/runtime.js');
const lifecycleSource=read('src/stremio/managed-playback-lifecycle.js');
const migration=read('db/migrations/019_stremio_managed_play_method.sql');
assert(managedSource.includes("{method:'POST',body}"),'managed PlaybackInfo must send a device profile in a POST body');
assert(managedSource.includes('DeviceProfile:stremioDeviceProfile()'),'managed PlaybackInfo must declare Stremio playback capabilities');
assert(managedSource.includes('source.TranscodingUrl'),'managed playback must honor Jellyfin compatibility URLs instead of forcing Static direct play');
assert(runtimeSource.includes('managedRuntime.playbackInfo(mapping,req.params.itemId,req.params.mediaSourceId)'),'playback admission must refresh the selected media-source negotiation');
assert(runtimeSource.includes('res.redirect(307,target.url)'),'managed playback must remain no-byte direct delivery while preserving request semantics across the Jellyfin redirect');
assert(runtimeSource.includes('playMethod:target.playMethod'),'managed admission audit must record the actual delivery method');
assert(lifecycleSource.includes("playMethod:row.play_method||'DirectPlay'"),'managed stop reporting must reuse the negotiated play method');
assert(migration.includes('play_method')&&migration.includes("'DirectStream'")&&migration.includes("'Transcode'"),'managed playback migration must persist the negotiated Jellyfin play method');

console.log('stremio playback compatibility smoke: ok');
