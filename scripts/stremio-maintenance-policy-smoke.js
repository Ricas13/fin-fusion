'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const jobs=read('src/automation/jobs.js');
const worker=read('scripts/automation-worker.js');
const pool=read('src/stremio/source-pool.js');
const index=read('src/stremio/source-index.js');
const tokens=read('src/stremio/external-token-maintenance.js');
const admin=read('src/platform/admin-stremio-sources.js');

assert(jobs.includes("async stremio_external_tokens(){return stremioExternalTokens.maintain"),'external token maintenance must have one dedicated automation owner');
assert(!jobs.includes('stremioSourcePool.rotateDueTokens'),'the scheduler must never use the legacy source-pool rotation path that lacks retired-token grace');
assert(worker.includes('stremio_external_tokens:300'),'token maintenance must sweep due rotation/revocation every five minutes');
assert(worker.includes('stremio_media_index:10800'),'Stremio indexing must be scheduled every three hours');
assert(tokens.includes('DEFAULT_ROTATION_HOURS=4')&&tokens.includes('TOKEN_GRACE_HOURS=1'),'direct external tokens must rotate every four hours with one-hour grace');
assert(tokens.includes("client.logoutToken(row.base_url,token"),'retired external tokens must be actively logged out of Jellyfin after grace');
assert(index.includes('INCREMENTAL_HOURS=3')&&index.includes('FULL_RECONCILE_HOURS=84'),'external index must use three-hour incrementals and twice-weekly full reconciliation');
assert(index.includes('clearAndQueue')&&index.includes("DELETE FROM stremio_source_media_index WHERE source_id=$1"),'clean rebuild must clear only the selected local external-source index');
assert(admin.includes('Clear index & rebuild')&&admin.includes("/admin/servers/stremio/:id/reindex"),'admin must expose the clear-and-rebuild operation');
assert(pool.includes('rotateDueTokens'),'legacy helper may remain for compatibility, but it must not own scheduled rotation');

console.log('stremio maintenance policy smoke: ok');
