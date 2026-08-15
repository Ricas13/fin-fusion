'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const router=read('src/platform/router.js');
const nav=read('src/platform/admin-nav.js');
const page=read('src/platform/admin-stremio.js');
const migration=read('db/migrations/066_stremio_service_foundation.sql');

assert(router.includes("createAdminStremioRouter"),'Stremio admin router must be mounted');
assert(nav.includes("['stremio-settings','Stremio','/admin/settings/stremio']"),'Stremio foundation must be discoverable from Settings');
assert(page.includes('Foundation only:'),'Admin page must clearly state that the production addon runtime is not live');
assert(page.includes("status IN ('pending','active','suspended')"),'Server eligibility removal must protect all assigned non-revoked Stremio entitlements');
assert(page.includes("'admin.stremio.server_eligibility'"),'Server eligibility changes must be audited');
assert(page.includes("routeRateLimit.middleware({scope:'admin-stremio-settings'"),'Stremio admin mutations must use the shared persistent rate limiter');
assert(/router\.post\('\/admin\/settings\/stremio\/servers\/:id',stremioMutationLimit,/.test(page),'Server eligibility mutation must apply the Stremio rate limiter');
assert(migration.includes("service_type IN ('jellyfin','stremio','bundle')"),'Plan service type constraint is missing');
assert(migration.includes('token_hash TEXT'),'Stremio entitlements must store a token hash field');
assert(!migration.includes('token_plaintext'),'Stremio schema must not introduce plaintext token storage');
assert(migration.includes('service_type_snapshot'),'Subscription service type must be snapshotted');
assert(migration.includes('enforce_stremio_entitlement_integrity'),'Database must enforce Stremio cross-record integrity');
assert(migration.includes('Stremio entitlement customer does not own subscription'),'Subscription/customer ownership mismatch must be rejected');
assert(migration.includes('Stremio Jellyfin account belongs to another customer'),'Jellyfin account/customer ownership mismatch must be rejected');
assert(migration.includes('Stremio Jellyfin account does not belong to assigned server'),'Jellyfin account/server mismatch must be rejected');
assert(migration.includes('Active Stremio entitlement requires server, Jellyfin account and install credential'),'Active entitlements must be fully assigned before use');

console.log('stremio admin foundation smoke: ok');
