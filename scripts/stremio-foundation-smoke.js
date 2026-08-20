'use strict';

const assert=require('assert');
const foundation=require('../src/stremio/foundation');

assert.deepStrictEqual(foundation.SERVICE_TYPES,['jellyfin','stremio','bundle']);
assert.strictEqual(foundation.allowsJellyfin('jellyfin'),true);
assert.strictEqual(foundation.allowsJellyfin('bundle'),true);
assert.strictEqual(foundation.allowsJellyfin('stremio'),false);
assert.strictEqual(foundation.allowsStremio('stremio'),true);
assert.strictEqual(foundation.allowsStremio('bundle'),true);
assert.strictEqual(foundation.allowsStremio('jellyfin'),false);

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
    '📦 18.0 GB • 24.0 Mbps • MKV'
]);

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
