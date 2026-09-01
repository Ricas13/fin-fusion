'use strict';

const crypto=require('crypto');
const path=require('path');
const runtimeSettings=require('./runtime-settings');
const serviceCatalog=require('../catalog/service-catalog');

const SERVICE_TYPES=serviceCatalog.SERVICE_TYPES;

function normalizeServiceType(value){
    const type=String(value||'jellyfin').trim().toLowerCase();
    if(!SERVICE_TYPES.includes(type))throw new Error('Unsupported service delivery type.');
    return type;
}
function allowsJellyfin(value){const type=normalizeServiceType(value);return type==='jellyfin'||type==='bundle';}
function allowsStremio(value){const type=normalizeServiceType(value);return type==='stremio'||type==='bundle';}
function runtimeReady(){
    if(!runtimeSettings.enabled())return false;
    try{const runtime=require('./runtime');return runtime?.available===true;}catch(_){return false;}
}
function assertAcquirable(plan,{context='acquisition'}={}){
    const type=normalizeServiceType(plan?.service_type||plan?.serviceType||'jellyfin');
    if(allowsStremio(type)&&!runtimeReady())throw new Error(`Stremio delivery is not available for ${context} until the production addon runtime is enabled.`);
    return plan;
}

function hashInstallCredential(raw){
    const token=String(raw||'').trim();
    if(token.length<32)throw new Error('Stremio install credential is invalid.');
    return crypto.createHash('sha256').update(token,'utf8').digest('hex');
}
function issueInstallCredential(){
    const token=crypto.randomBytes(32).toString('base64url');
    return {token,hash:hashInstallCredential(token),hint:`…${token.slice(-6)}`};
}

function tokenBoundary(expression){return new RegExp(`(?:^|[\\s._\\-\\[\\]()])(?:${expression})(?=$|[\\s._\\-\\[\\]()])`,'i');}
function firstMatch(value,items){for(const [label,pattern] of items){if(pattern.test(value))return label;}return null;}

function parseFilenameMetadata(filename){
    const original=path.basename(String(filename||''));
    // STRM libraries often expose names such as `Release-GROUP.mkv.strm`.
    // Strip the wrapper extension first, then the underlying media extension,
    // so the release group shown to Stremio never becomes `GROUP.mkv`.
    const base=original
        .replace(/\.strm$/i,'')
        .replace(/\.(?:mkv|mp4|m4v|avi|ts|m2ts|mov)$/i,'');
    const resolution=firstMatch(base,[['4K',tokenBoundary('2160p|4k|uhd')],['1080p',tokenBoundary('1080p|1080i')],['720p',tokenBoundary('720p')],['480p',tokenBoundary('480p|576p')]]);
    const source=firstMatch(base,[['REMUX',tokenBoundary('remux')],['BluRay',tokenBoundary('blu[ ._-]?ray|bluray|bdrip|brrip')],['WEB-DL',tokenBoundary('web[ ._-]?dl|webdl')],['WEBRip',tokenBoundary('webrip')],['HDTV',tokenBoundary('hdtv')],['DVD',tokenBoundary('dvdrip|dvd')]]);
    const codec=firstMatch(base,[['AV1',tokenBoundary('av1')],['HEVC',tokenBoundary('hevc|h[ ._-]?265|x265')],['AVC',tokenBoundary('avc|h[ ._-]?264|x264')]]);
    const dynamicRange=[];
    if(tokenBoundary('dovi|dolby[ ._-]?vision|dv').test(base))dynamicRange.push('Dolby Vision');
    if(tokenBoundary('hdr10\\+|hdr10plus').test(base))dynamicRange.push('HDR10+');
    else if(tokenBoundary('hdr10').test(base))dynamicRange.push('HDR10');
    else if(tokenBoundary('hdr').test(base))dynamicRange.push('HDR');
    const audio=firstMatch(base,[['TrueHD Atmos',/truehd[^A-Za-z0-9]*atmos/i],['TrueHD',tokenBoundary('truehd')],['DTS-HD MA',/dts[ ._-]?hd(?:[ ._-]?ma)?/i],['DTS:X',/dts[ ._-]?x/i],['DDP Atmos',/(?:ddp|eac3|e-ac-3)[^A-Za-z0-9]*atmos/i],['DDP',tokenBoundary('ddp|eac3|e-ac-3')],['AC3',tokenBoundary('ac3|ac-3')],['AAC',tokenBoundary('aac')]]);
    const channels=firstMatch(base,[['7.1',tokenBoundary('7[ ._-]?1')],['5.1',tokenBoundary('5[ ._-]?1')],['2.0',tokenBoundary('2[ ._-]?0')]]);
    const groupMatch=base.match(/-([A-Za-z0-9][A-Za-z0-9._]{1,30})$/);
    const releaseGroup=groupMatch?groupMatch[1]:null;
    return {filename:original,resolution,source,codec,dynamicRange,audio,channels,releaseGroup};
}

function streamDisplayFromFilename(filename,{prefix='CF ⚡'}={}){
    const info=parseFilenameMetadata(filename),description=[];
    const release=[info.source,info.releaseGroup].filter(Boolean),video=[info.codec,...info.dynamicRange].filter(Boolean),sound=[info.audio,info.channels].filter(Boolean);
    if(release.length)description.push(`🎬 ${release.join(' • ')}`);
    if(video.length)description.push(`📺 ${video.join(' • ')}`);
    if(sound.length)description.push(`🔊 ${sound.join(' • ')}`);
    return {name:`[${prefix}] ${info.resolution||'Stream'}`,description:description.join('\n'),metadata:info};
}
function bytesLabel(value){
    const bytes=Number(value||0);
    // Tiny positive sizes are usually the .strm wrapper itself, not the media.
    // Hiding sub-megabyte values also avoids meaningless labels such as `0 MB`.
    if(!(bytes>=1024**2))return'';
    const gb=bytes/(1024**3);
    return gb>=1?`${gb.toFixed(gb>=10?1:2)} GB`:`${(bytes/(1024**2)).toFixed(0)} MB`;
}
function cleanTechnicalTitle(value){
    return String(value||'').trim()
        .replace(/\s+-\s+/g,' • ')
        .replace(/\s+\+\s+/g,' • ')
        .replace(/\b(?:Default|Original)\b/gi,'')
        .replace(/Dolby Digital Plus/gi,'DD+')
        .replace(/Dolby Atmos/gi,'Atmos')
        .replace(/Dolby Vision Profile\s*/gi,'Dolby Vision P')
        .replace(/\((HDR10\+?|HDR)\)/gi,' • $1')
        .replace(/\b(HEVC|AVC|AV1)\s+(Dolby Vision|HDR10\+?|HDR)\b/gi,'$1 • $2')
        .replace(/\bDD\+\s*•\s*Atmos\b/gi,'DD+ Atmos')
        .replace(/\s*•\s*•\s*/g,' • ')
        .replace(/^\s*•\s*|\s*•\s*$/g,'')
        .replace(/\s{2,}/g,' ')
        .trim();
}
function withoutResolution(value,resolution){
    let text=cleanTechnicalTitle(value),token=String(resolution||'').trim();
    if(!token)return text;
    const escaped=token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    text=text.replace(new RegExp(`^${escaped}(?:\\s+|\\s*•\\s*)`,'i'),'').trim();
    if(token==='4K')text=text.replace(/^2160p(?:\s+|\s*•\s*)/i,'').trim();
    return text;
}
function subtitleLabel(stream){
    const title=String(stream?.DisplayTitle||'').trim(),first=title.split(/\s+-\s+/)[0]?.trim(),language=first||String(stream?.Language||'').trim()||'Subtitle',flags=[];
    if(stream?.IsForced||/\bforced\b/i.test(title))flags.push('Forced');
    if(stream?.IsHearingImpaired||/\bSDH\b/i.test(title))flags.push('SDH');
    if(/\bCC\b/i.test(title))flags.push('CC');
    return [language,...flags].join(' • ');
}
function replaceLine(parts,icon,value){
    const label=String(value||'').trim();if(!label)return;
    const index=parts.findIndex(part=>part.startsWith(`${icon} `));
    if(index>=0)parts[index]=`${icon} ${label}`;else parts.push(`${icon} ${label}`);
}
function richStreamDescription(display,media){
    const parts=String(display?.description||'').split('\n').map(value=>value.trim()).filter(Boolean),streams=Array.isArray(media?.MediaStreams)?media.MediaStreams:[];
    const video=streams.find(stream=>String(stream?.Type||'').toLowerCase()==='video'),audio=streams.find(stream=>String(stream?.Type||'').toLowerCase()==='audio'),subtitles=streams.filter(stream=>String(stream?.Type||'').toLowerCase()==='subtitle'),resolution=display?.metadata?.resolution||'';
    if(video?.DisplayTitle)replaceLine(parts,'📺',withoutResolution(video.DisplayTitle,resolution));
    if(audio?.DisplayTitle)replaceLine(parts,'🔊',cleanTechnicalTitle(audio.DisplayTitle));
    const subtitleLabels=[...new Set(subtitles.map(subtitleLabel).filter(Boolean))].slice(0,3);
    if(subtitleLabels.length)parts.push(`💬 ${subtitleLabels.join(' • ')}${subtitles.length>subtitleLabels.length?` +${subtitles.length-subtitleLabels.length}`:''}`);
    // Container/extension is deliberately omitted from the customer-facing
    // result. For STRM-backed libraries it describes the wrapper rather than
    // useful playback quality. Keep genuine file size and bitrate when known.
    const technical=[],size=bytesLabel(media?.Size);if(size)technical.push(size);if(Number(media?.Bitrate)>0)technical.push(`${(Number(media.Bitrate)/1000000).toFixed(1)} Mbps`);if(technical.length)parts.push(`📦 ${technical.join(' • ')}`);
    return parts.join('\n')||'▶️ Stream';
}

module.exports={SERVICE_TYPES,normalizeServiceType,allowsJellyfin,allowsStremio,runtimeReady,assertAcquirable,hashInstallCredential,issueInstallCredential,parseFilenameMetadata,streamDisplayFromFilename,bytesLabel,cleanTechnicalTitle,subtitleLabel,richStreamDescription};