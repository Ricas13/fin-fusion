'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const foundation=require('../src/stremio/foundation');

const runtimeSource=fs.readFileSync(path.resolve(__dirname,'../src/stremio/runtime.js'),'utf8');
const originBlock=runtimeSource.match(/async function publicOrigin\(req\) \{[\s\S]*?\n\}/)?.[0]||'';
assert(originBlock,'Stremio publicOrigin helper must exist');
assert.match(originBlock,/operations\.absoluteUrl\(req, '\/'\)/,'Stremio public URLs must delegate to the canonical platform origin policy');
assert.doesNotMatch(originBlock,/x-forwarded-host|x-forwarded-proto|req\.get\(['"]host['"]\)|req\.headers\.host/i,'Stremio must not maintain a route-local forwarded Host/Proto origin policy');
assert.doesNotMatch(runtimeSource,/x-forwarded-host|x-forwarded-proto/i,'Stremio runtime must not construct public URLs directly from forwarded headers');

assert.deepStrictEqual(foundation.SERVICE_TYPES,['jellyfin','stremio','emby','bundle']);
assert.strictEqual(foundation.allowsJellyfin('jellyfin'),true);
assert.strictEqual(foundation.allowsJellyfin('bundle'),true);
assert.strictEqual(foundation.allowsJellyfin('stremio'),false);
assert.strictEqual(foundation.allowsJellyfin('emby'),false,'Emby must not be treated as Jellyfin delivery by Stremio foundation helpers');
assert.strictEqual(foundation.allowsStremio('stremio'),true);
assert.strictEqual(foundation.allowsStremio('bundle'),true);
assert.strictEqual(foundation.allowsStremio('jellyfin'),false);
assert.strictEqual(foundation.allowsStremio('emby'),false,'Emby must remain independent from Stremio delivery');

const credential=foundation.issueInstallCredential();
assert(credential.token.length>=40,'Install credential must have high entropy');
assert(/^[0-9a-f]{64}$/.test(credential.hash),'Only a SHA-256 token hash should be stored');
assert.strictEqual(foundation.hashInstallCredential(credential.token),credential.hash,'Install credential hashing must be deterministic');
assert(!credential.hint.includes(credential.token),'Credential hint must not expose the complete bearer token');

const rich=foundation.streamDisplayFromFilename('Movie.Name.2026.2160p.WEB-DL.HEVC.DV.DDP.Atmos.5.1-MGE.strm');
assert.strictEqual(rich.name,'[CF ⚡] 4K');
assert.strictEqual(rich.metadata.resolution,'4K');
assert.strictEqual(rich.metadata.source,'WEB-DL');
assert.strictEqual(rich.metadata.codec,'HEVC');
assert(rich.metadata.dynamicRange.includes('Dolby Vision'));
assert.strictEqual(rich.metadata.audio,'DDP Atmos');
assert.strictEqual(rich.metadata.channels,'5.1');
assert.strictEqual(rich.metadata.releaseGroup,'MGE');
assert(rich.description.includes('WEB-DL')&&rich.description.includes('Dolby Vision')&&rich.description.includes('MGE'));

const card=foundation.richStreamDescription(rich,{
    Container:'mkv',
    Bitrate:24000000,
    Size:18*(1024**3),
    MediaStreams:[
        {Type:'Video',DisplayTitle:'4K HEVC Dolby Vision Profile 8.1 (HDR10)'},
        {Type:'Audio',DisplayTitle:'English - Dolby Digital Plus + Dolby Atmos - 5.1 - Default - Original'},
        {Type:'Subtitle',Language:'eng',DisplayTitle:'English - SUBRIP - SDH'}
    ]
});
assert.deepStrictEqual(card.split('\n'),[
    '🎬 WEB-DL • MGE',
    '📺 HEVC • Dolby Vision P8.1 • HDR10',
    '🔊 English • DD+ Atmos • 5.1',
    '💬 English • SDH',
    '📦 18.0 GB • 24.0 Mbps'
]);
assert(!card.includes('MKV'),'Container/file extensions must not be shown in customer-facing Stremio results');

const wrapped=foundation.streamDisplayFromFilename('Movie.Name.2026.1080p.WEB-DL.AVC.AC3.5.1-Slay3R.mkv.strm');
assert.strictEqual(wrapped.metadata.releaseGroup,'Slay3R','stacked media + STRM extensions must not leak into the release group');
assert.strictEqual(wrapped.description.split('\n')[0],'🎬 WEB-DL • Slay3R');
const wrappedCard=foundation.richStreamDescription(wrapped,{Container:'strm',Size:8192,MediaStreams:[]});
assert(!wrappedCard.includes('0 MB'),'tiny STRM wrapper sizes must not render as 0 MB');
assert(!wrappedCard.includes('STRM'),'STRM wrapper extensions must not be shown');
assert(!wrappedCard.includes('.mkv'),'underlying file extensions must not leak into release-group labels');
assert(!wrappedCard.includes('📦'),'empty technical rows must disappear completely');

const web1080=foundation.streamDisplayFromFilename('Future.Man.S02E12.The.Brain.Job.WEBRip-1080p-DEFLATE.strm');
assert.strictEqual(web1080.name,'[CF ⚡] 1080p');
assert.strictEqual(web1080.metadata.source,'WEBRip');
assert.strictEqual(web1080.metadata.releaseGroup,'DEFLATE');

const minimal=foundation.streamDisplayFromFilename('Some.Movie.2025.720p.strm');
assert.strictEqual(minimal.name,'[CF ⚡] 720p');
assert.strictEqual(minimal.metadata.codec,null,'Unknown codec must not be invented');
assert.strictEqual(minimal.metadata.audio,null,'Unknown audio must not be invented');

const unknown=foundation.streamDisplayFromFilename('Some.Movie.2025.strm');
assert.strictEqual(unknown.name,'[CF ⚡] Stream');

console.log('stremio foundation smoke: ok');