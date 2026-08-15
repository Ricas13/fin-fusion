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
assert(page.includes("status='active'"),'Server eligibility removal must check active Stremio entitlements');
assert(page.includes("'admin.stremio.server_eligibility'"),'Server eligibility changes must be audited');
assert(migration.includes("service_type IN ('jellyfin','stremio','bundle')"),'Plan service type constraint is missing');
assert(migration.includes('token_hash TEXT'),'Stremio entitlements must store a token hash field');
assert(!migration.includes('token_plaintext'),'Stremio schema must not introduce plaintext token storage');
assert(migration.includes('service_type_snapshot'),'Subscription service type must be snapshotted');

console.log('stremio admin foundation smoke: ok');
