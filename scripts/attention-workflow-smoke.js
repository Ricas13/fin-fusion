'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const attention=read('src/platform/attention.js');
const admin=read('src/platform/admin-attention.js');
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
assert(attention.includes("href:`/admin/servers/${r.id}/edit`"),'Server health findings must deep-link to the real server edit route');
assert(attention.includes("href:`/admin/backups?run=${encodeURIComponent(r.id)}#backup-${encodeURIComponent(r.id)}`"),'Backup findings must deep-link to the matching backup run');
assert(admin.includes('class="attentionActionGrid"'),'Attention operator controls must be compact side-by-side without depending on client-side detection');
assert(operator.includes('attention.openSummary()'),'Unread operator state must count live attention findings instead of querying a phantom state table');

console.log('attention workflow smoke: ok');
