'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const attention=read('src/platform/attention.js');
const admin=read('src/platform/admin-attention.js');
const servers=read('src/platform/admin-servers-dashboard.js');
const operator=read('src/platform/admin-operator-state.js');
const baseline=read('db/migrations/000_database_baseline.sql');

assert(/CREATE TABLE public\.attention_workflow \(/.test(baseline),'Baseline schema must define the canonical attention_workflow table');
assert(/acknowledged_at timestamp with time zone/.test(baseline),'Canonical attention_workflow table must retain its acknowledgement column');
assert(!attention.includes('attention_state'),'Attention runtime must not query the non-existent attention_state table');
assert(attention.includes('attention_workflow'),'Attention runtime must use the canonical attention_workflow table');
assert(attention.includes('fingerprint=ANY($1::text[])'),'Attention state lookup must join live findings by workflow fingerprint');
assert(attention.includes("Attention workflow state unavailable:"),'Attention list must remain readable if workflow state is temporarily unavailable during a rolling upgrade');
assert(attention.includes("return[];"),'Attention state failure must fall back to open live findings rather than fail the whole page');
assert(attention.includes("acknowledged_at!=null?'acknowledged':'open'"),'Attention status must derive from acknowledgement state while the source remains authoritative');
assert(attention.includes("href:`/admin/servers/dashboard?server=${encodeURIComponent(r.id)}`"),'Server health findings must preserve the affected server when opening the fleet control room');
assert(servers.includes('selectedServerResolution')&&servers.includes('/admin/servers/${esc(server.id)}/edit'),'Fleet control room must turn server issue context into an explicit corrective settings action');
assert(attention.includes('WITH latest_success AS'),'Backup attention must derive from current recovery state instead of listing historical runs');
assert(attention.includes('latest_failure AS'),'Backup attention must retain the newest unresolved backup failure');
assert(attention.includes("WHERE verified_at IS NULL AND started_at<NOW()-INTERVAL '2 days'"),'Backup verification warning must only consider the latest successful recovery point after the grace period');
assert(!attention.includes("FROM backup_runs WHERE status='failed' OR (status='succeeded' AND verified_at IS NULL"),'Attention must not create one warning for every historical unverified backup');
assert(attention.includes("title:r.status==='failed'?'Backup failed':'Latest backup has not been restore-verified'"),'Backup attention copy must describe a current recovery condition');
assert(attention.includes("href:`/admin/backups?run=${encodeURIComponent(r.id)}#backup-${encodeURIComponent(r.id)}`"),'Backup findings must deep-link to the matching current backup run');
assert(admin.includes('class="attentionActionGrid"'),'Attention operator controls must be compact side-by-side without depending on client-side detection');
assert(admin.includes('Issue & fix')&&admin.includes('actionLabel'),'Attention UI must present corrective intent separately from acknowledgement workflow');
assert(operator.includes('attention.openSummary()'),'Unread operator state must count live attention findings instead of querying a phantom state table');

console.log('attention workflow smoke: ok');
