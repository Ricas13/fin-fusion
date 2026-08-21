'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const helper=read('src/stremio/episode-resolution.js');
const managed=read('src/stremio/managed-runtime.js');
const external=read('src/stremio/external-direct-runtime.js');

for(const token of ["Recursive:'true'","IncludeItemTypes:'Episode'","IndexNumber:String(episodeNumber)","ParentIndexNumber:String(seasonNumber)","Limit:'25'","EnableTotalRecordCount:'false'"]){
  assert(helper.includes(token),`targeted episode query missing ${token}`);
}
assert(helper.includes('ParentId:series'),'episode lookup must remain scoped to the indexed series root');
assert(helper.includes('function pick(payload,season,episode)'),'targeted response must be verified by season/episode before use');

assert(managed.includes('episodeResolution.userItemsPath'),'managed TV lookup must attempt the targeted Items query first');
assert(managed.includes("fields:'Path'"),'managed targeted lookup should request only the path before PlaybackInfo');
assert(managed.includes('jellyfin.resolveItem(runtime,args)'),'managed runtime must retain compatibility fallback after a targeted miss');
assert(managed.indexOf('episodeResolution.userItemsPath')<managed.indexOf('jellyfin.resolveItem(runtime,args)'),'managed fallback must occur only after the targeted lookup');

assert(external.includes('episodeResolution.userItemsPath'),'external TV lookup must attempt the targeted Items query first');
assert(/fields:\s*'Path,MediaSources,MediaStreams'/.test(external),'external targeted lookup must return ordinary item media metadata without PlaybackInfo');
assert(/Limit:\s*'500'/.test(external),'external runtime must retain a compatibility fallback for servers that ignore exact filters');
assert(external.indexOf('episodeResolution.userItemsPath')<external.search(/Limit:\s*'500'/),'external legacy episode listing must only be fallback');
assert(!external.includes('/PlaybackInfo'),'external episode optimization must remain unmanaged and PlaybackInfo-free');

console.log('stremio targeted episode resolution smoke: ok');
