'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const attention=read('src/platform/attention.js');
const admin=read('src/platform/admin-attention.js');
const operator=read('src/platform/admin-operator-state.js');
const migration=read('db/migrations/051_attention_workflow.sql');

assert(migration.includes('CREATE TABLE IF NOT EXISTS attention_workflow'),'Attention workflow migration must define the canonical workflow table');
assert(!attention.includes('attention_state'),'Attention runtime must not query the non-existent attention_state table');
assert(attention.includes('attention_workflow'),'Attention runtime must use the canonical attention_workflow table');
assert(attention.includes('fingerprint=ANY($1::text[])'),'Attention state lookup must join live findings by workflow fingerprint');
assert(attention.includes("acknowledged_at IS NOT NULL?'acknowledged':'open'"),'Attention status must derive from acknowledgement state while the source remains authoritative');
assert(attention.includes("href:`/admin/servers/${r.id}/edit`"),'Server health findings must deep-link to the real server edit route');
assert(attention.includes("href:`/admin/backups?run=${encodeURIComponent(r.id)}#backup-${encodeURIComponent(r.id)}`"),'Backup findings must deep-link to the matching backup run');
assert(admin.includes('class="attentionActionGrid"'),'Attention operator controls must be compact side-by-side without depending on client-side detection');
assert(operator.includes('attention.openSummary()'),'Unread operator state must count live attention findings instead of querying a phantom state table');

console.log('attention workflow smoke: ok');
