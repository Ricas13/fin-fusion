'use strict';

const fs=require('fs');
const assert=require('assert');
const read=file=>fs.readFileSync(file,'utf8');
const migration=read('db/migrations/076_jellyfin_lifecycle_stremio_sources.sql');
const lifecycle=read('src/automation/jellyfin-lifecycle.js');
const policy=read('src/entitlements/jellyfin-lifecycle-policy.js');
const jobs=read('src/automation/jobs.js');
const pool=read('src/stremio/source-pool.js');
const runtime=read('src/stremio/runtime.js');
const admin=read('src/platform/admin-stremio-sources.js');

for(const expected of ['"freeNoPlaybackDays":7','"freeDeleteAfterDisableDays":7','"trialDeleteAfterDisableDays":30','"paidDeleteAfterDisableDays":30','"resellerDeleteAfterDisableDays":30'])assert(migration.includes(expected),`missing default ${expected}`);
assert(lifecycle.includes('provisioning.disableJellyfinAccount(row)'), 'lifecycle must disable the Jellyfin account directly');
assert(!lifecycle.includes('accessHolds'), 'lifecycle must not create portal/customer access holds');
assert(!/UPDATE\s+customers|DELETE\s+FROM\s+customers/i.test(lifecycle), 'lifecycle must never update/delete portal customers');
assert(jobs.includes('async customer_inactivity(){return jellyfinLifecycle.run()}'), 'legacy dormant cleanup must not remain canonical');
assert(policy.includes("portalAccountPreserved:true"), 'policy audit must record portal preservation');
assert(migration.includes("source_kind='owned' OR authorization_confirmed=TRUE"), 'external Stremio sources must require authorization');
assert(pool.includes("Confirm that you are authorized"), 'external source creation must enforce authorization');
assert(pool.includes('stremio_stream_attribution'), 'source pool must retain CAPTaINFiN attribution');
assert(runtime.indexOf('sourcePool.streamsFor')<runtime.indexOf('jellyfin.streamsFor'), 'source pool must be attempted before entitlement fallback');
assert(admin.includes('does not hide, forge or suppress upstream Jellyfin activity'), 'admin UI must state upstream activity is not concealed');
assert(migration.includes('portal customer'), 'migration must document portal identity invariant');
console.log('Jellyfin lifecycle + Stremio source-pool smoke: OK');
