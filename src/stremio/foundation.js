'use strict';

const crypto=require('crypto');
const path=require('path');
const runtimeSettings=require('./runtime-settings');

const SERVICE_TYPES=Object.freeze(['jellyfin','stremio','bundle']);

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
    const base=original.replace(/\.(?:strm|mkv|mp4|m4v|avi|ts|m2ts|mov)$/i,'');
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
    const info=parseFilenameMetadata(filename),video=[info.source,info.codec,...info.dynamicRange].filter(Boolean),sound=[info.audio,info.channels].filter(Boolean),description=[];
    if(video.length)description.push(`🎞️ ${video.join(' • ')}`);if(sound.length)description.push(`🔊 ${sound.join(' • ')}`);if(info.releaseGroup)description.push(`🏷️ ${info.releaseGroup}`);
    return {name:`[${prefix}] ${info.resolution||'Stream'}`,description:description.join('\n'),metadata:info};
}
function bytesLabel(value){const bytes=Number(value||0);if(!(bytes>0))return'';const gb=bytes/(1024**3);return gb>=1?`${gb.toFixed(gb>=10?1:2)} GB`:`${(bytes/(1024**2)).toFixed(0)} MB`;}
function richStreamDescription(display,media){
    const parts=String(display?.description||'').split('\n').map(value=>value.trim()).filter(Boolean),streams=Array.isArray(media?.MediaStreams)?media.MediaStreams:[];
    const video=streams.find(stream=>String(stream?.Type||'').toLowerCase()==='video'),audio=streams.find(stream=>String(stream?.Type||'').toLowerCase()==='audio'),subtitles=streams.filter(stream=>String(stream?.Type||'').toLowerCase()==='subtitle');
    if(video?.DisplayTitle&&!parts.some(part=>part.includes(video.DisplayTitle)))parts.push(`📺 ${video.DisplayTitle}`);
    if(audio?.DisplayTitle&&!parts.some(part=>part.includes(audio.DisplayTitle)))parts.push(`🔊 ${audio.DisplayTitle}`);
    const subtitleLabels=[...new Set(subtitles.map(stream=>String(stream.DisplayTitle||stream.Language||'').trim()).filter(Boolean))].slice(0,4);
    if(subtitleLabels.length)parts.push(`💬 ${subtitleLabels.join(' • ')}${subtitles.length>subtitleLabels.length?` +${subtitles.length-subtitleLabels.length}`:''}`);
    const technical=[];if(media?.Container)technical.push(String(media.Container).toUpperCase());if(Number(media?.Bitrate)>0)technical.push(`${(Number(media.Bitrate)/1000000).toFixed(1)} Mbps`);const size=bytesLabel(media?.Size);if(size)technical.push(size);if(technical.length)parts.push(`📦 ${technical.join(' • ')}`);
    return parts.join('\n')||'▶️ Stream';
}

module.exports={SERVICE_TYPES,normalizeServiceType,allowsJellyfin,allowsStremio,runtimeReady,assertAcquirable,hashInstallCredential,issueInstallCredential,parseFilenameMetadata,streamDisplayFromFilename,bytesLabel,richStreamDescription};
