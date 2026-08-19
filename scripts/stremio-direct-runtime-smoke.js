'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const migration=read('db/migrations/016_stremio_managed_source_foundation.sql');
const identities=read('src/stremio/managed-entitlements.js');
const managed=read('src/stremio/managed-runtime.js');
const external=read('src/stremio/external-direct-runtime.js');
const runtime=read('src/stremio/runtime.js');

assert(migration.includes('stremio_managed_accounts'),'managed multi-server identity foundation missing');
assert(identities.includes("account_purpose='stremio_internal'"),'managed playback must use hidden Stremio-only Jellyfin accounts');
assert(identities.includes('MaxActiveSessions:disabled?0:limit'),'hidden managed users must retain Jellyfin-side session limits');
assert(identities.includes('managedSources.enabled()'),'managed identity provisioning must follow managed source configuration');
assert(managed.includes('/PlaybackInfo?'),'managed streams must be resolved through Jellyfin PlaybackInfo');
assert(managed.includes("url.searchParams.set('PlaySessionId'"),'managed direct URL must carry PlaybackInfo PlaySessionId when available');
assert(managed.includes("url.searchParams.set('api_key',token)"),'managed direct URL must use the restricted hidden-user token');
assert(!managed.includes('api_key_encrypted'),'managed runtime must never read the server administrator API key');
assert(!managed.includes('/stremio/${'),'new managed stream URLs must not point at the CAPTAiNFiN byte proxy');
assert(external.includes("url.searchParams.set('api_key',client.sourceToken(source))"),'external direct playback must use its dedicated Jellyfin source token');
assert(!external.includes('/stremio/${'),'new external stream URLs must not point at the CAPTAiNFiN byte proxy');
assert(external.includes('Promise.allSettled(sources.map'),'external source resolution must run concurrently');
assert(runtime.includes('Promise.all([')&&runtime.includes('managedRuntime.streamsFor')&&runtime.includes('externalRuntime.streamsFor'),'managed/external resolution must run concurrently');
assert(runtime.includes('const streams=[...managed,...external]'),'managed results must always be emitted before external results');
assert(runtime.includes('Source type/name is never added'),'runtime must preserve source-neutral customer presentation');
assert(runtime.includes('Compatibility-only proxy routes'),'old proxy endpoints may exist only for cached-manifest compatibility');
assert(!managed.includes('source.name')&&!external.includes('source.name'),'customer stream builders must not label results with source names');

console.log('stremio direct runtime smoke: ok');
