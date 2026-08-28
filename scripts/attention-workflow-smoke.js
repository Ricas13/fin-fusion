'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const attentionPolicy=require('../src/platform/actionable-attention-policy');

const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const attention=read('src/platform/attention.js');
const admin=read('src/platform/admin-attention.js');
const dashboard=read('src/platform/admin-dashboard.js');
const provisioning=read('src/platform/admin-provisioning.js');
const registry=read('src/jellyfin/registry.js');
const servers=read('src/platform/admin-servers-dashboard.js');
const operator=read('src/platform/admin-operator-state.js');
const baseline=read('db/migrations/000_database_baseline.sql');

assert(/CREATE TABLE public\.attention_workflow \(/.test(baseline),'Baseline schema must define the canonical attention_workflow table');
assert(/acknowledged_at timestamp with time zone/.test(baseline),'Canonical attention_workflow table must retain its acknowledgement column');
assert(!attention.includes('attention_state'),'Attention runtime must not query the non-existent attention_state table');
assert(attention.includes('attention_workflow'),'Attention runtime must use the canonical attention_workflow table');
assert(attention.includes('fingerprint=ANY($1::text[])'),'Attention state lookup must join live findings by workflow fingerprint');
assert(attention.includes("Attention workflow state unavailable:"),'Attention list must remain readable if workflow state is temporarily unavailable during a rolling upgrade');
assert(attention.includes("acknowledged_at!=null?'acknowledged':'open'"),'Attention status must derive from acknowledgement state while the source remains authoritative');
assert(attention.includes("href:`/admin/servers/dashboard?server=${encodeURIComponent(row.id)}`"),'Server health findings must preserve a single affected server when opening fleet recovery');
assert(servers.includes('selectedServerResolution')&&servers.includes('/admin/servers/${esc(server.id)}/edit'),'Fleet control room must turn server issue context into an explicit corrective settings action');

const now=Date.now();
const failedProvisioning=(failures,extra={})=>({status:'failed',consecutive_failures:failures,last_attempt_at:new Date(now-60_000).toISOString(),...extra});
assert.strictEqual(attentionPolicy.provisioningDecision(failedProvisioning(1),now).visible,false,'first provisioning failure must stay inside automatic retry');
assert.strictEqual(attentionPolicy.provisioningDecision(failedProvisioning(2),now).visible,false,'second provisioning failure must stay inside automatic retry');
assert.strictEqual(attentionPolicy.provisioningDecision(failedProvisioning(3),now).severity,'warning','third consecutive provisioning failure should become a warning');
assert.strictEqual(attentionPolicy.provisioningDecision(failedProvisioning(6),now).severity,'critical','sixth consecutive provisioning failure should become critical');
assert.strictEqual(attentionPolicy.provisioningDecision({status:'healthy'},now).visible,false,'healthy provisioning state must never remain in Needs Attention');
assert.strictEqual(attentionPolicy.provisioningDecision(failedProvisioning(1,{last_action:'disable'}),now).severity,'critical','failed access removal must remain immediately critical');
assert.strictEqual(attentionPolicy.provisioningDecision({status:'blocked',problem_started_at:new Date(now-2*60_000).toISOString()},now).visible,false,'fresh blocked provisioning must get a short tolerance window');
assert.strictEqual(attentionPolicy.provisioningDecision({status:'blocked',problem_started_at:new Date(now-6*60_000).toISOString()},now).severity,'warning','persistently blocked provisioning must become operator-reviewable');

assert(attention.includes('FROM customer_provisioning_state cps'),'Needs Attention must use current customer provisioning state as its authority');
assert(!attention.includes("FROM provisioning_runs WHERE started_at>NOW()-INTERVAL '7 days'"),'historical provisioning runs must not be the live problem authority');
assert(attention.includes("key:key('provisioning',row.customer_id)"),'provisioning attention fingerprint must stay stable across retries');
assert(attention.includes('/admin/provisioning?customer='),'provisioning attention must deep-link to focused recovery rather than the giant customer access form');
assert(!attention.includes('protectedActivations'),'protected stale activation tokens are lifecycle hygiene, not operator intervention');
assert(!attention.includes("status IN('failed','dead')"),'retryable notification failures must not be emitted individually');
assert(attention.includes('attempts>=5')&&attention.includes("INTERVAL '6 hours'"),'email failures must get a long automatic retry tolerance before aggregate warning');
assert(attention.includes("auth_state='reconnect_required'"),'Stremio credential reconnect must remain operator-actionable');
assert(!attention.includes("auth_state IN('reconnect_required','error')"),'generic retryable Stremio source errors must not interrupt immediately');

assert.strictEqual(attentionPolicy.jobDecision({job_key:'billing',consecutive_failures:1},'failed').visible,false,'first automation failure must stay in auto-retry');
assert.strictEqual(attentionPolicy.jobDecision({job_key:'billing',consecutive_failures:3},'failed').severity,'warning','third automation failure should surface as warning');
assert.strictEqual(attentionPolicy.jobDecision({job_key:'billing',consecutive_failures:6},'failed').severity,'critical','persistent core automation failure should escalate to critical');
assert.strictEqual(attentionPolicy.jobDecision({job_key:'customer_inactivity',consecutive_failures:9},'failed').severity,'warning','non-core maintenance automation should not become critical merely from retries');
assert.strictEqual(attentionPolicy.workerDecision({last_heartbeat_at:new Date(now-4*60_000),draining_at:null},now,3600).visible,false,'brief heartbeat gaps must stay out of attention');
assert.strictEqual(attentionPolicy.workerDecision({last_heartbeat_at:new Date(now-6*60_000),draining_at:null},now,3600).severity,'warning','sustained worker heartbeat loss should warn');
assert.strictEqual(attentionPolicy.workerDecision({last_heartbeat_at:new Date(now-16*60_000),draining_at:null},now,3600).severity,'critical','long worker heartbeat loss should become critical');
assert.strictEqual(attentionPolicy.workerDecision({last_heartbeat_at:new Date(now-60*60_000),draining_at:new Date(now)},now,3600).visible,false,'planned worker drain must not create a false alarm');
assert.strictEqual(attentionPolicy.serverDecision({health_status:'degraded'},{consecutive_failures:9}).visible,false,'first-miss degraded server state is diagnostic only');
assert.strictEqual(attentionPolicy.serverDecision({health_status:'offline'},{consecutive_failures:2}).visible,false,'offline server must wait for repeated fleet health failures');
assert.strictEqual(attentionPolicy.serverDecision({health_status:'offline'},{consecutive_failures:3}).severity,'warning','persistent server outage should warn');
assert.strictEqual(attentionPolicy.serverDecision({health_status:'offline'},{consecutive_failures:6}).severity,'critical','long repeated server outage should become critical');

assert.strictEqual(attentionPolicy.paymentDecision({incident_type:'refund',scope:'customer',customer_id:'x'}).visible,false,'mapped refunds are lifecycle history, not dashboard work');
assert.strictEqual(attentionPolicy.paymentDecision({incident_type:'failed_renewal',scope:'customer',customer_id:'x'}).visible,false,'mapped failed renewals should follow provider retry/lifecycle without immediate dashboard interruption');
assert.strictEqual(attentionPolicy.paymentDecision({incident_type:'checkout_completion',scope:'customer',customer_id:'x'}).visible,false,'mapped checkout completions are lifecycle history once customer reconciliation is known');
assert.strictEqual(attentionPolicy.paymentDecision({incident_type:'dispute',scope:'customer',customer_id:'x'}).severity,'critical','payment disputes require human review');
assert.strictEqual(attentionPolicy.paymentDecision({incident_type:'checkout_completion',scope:'unresolved',customer_id:null}).severity,'critical','unresolved checkout completion must remain urgent');

assert(registry.includes("health_status=CASE WHEN health_status IN('degraded','offline') THEN 'offline' ELSE 'degraded' END"),'a single Jellyfin health miss must degrade before a consecutive miss marks offline');
assert(registry.includes('operationError(server,method,url,timeoutMs,error)'),'Jellyfin transport errors must carry operation context');
assert(registry.includes('timed out after ${Math.round(Number(timeoutMs||10000)/1000)}s'),'timeout diagnostics must state how long and which operation was waiting');

assert(provisioning.includes('selectedRecoveryCard'),'provisioning must provide a focused recovery card for attention deep-links');
assert(provisioning.includes('req.query.customer'),'focused provisioning recovery must resolve the selected customer from the attention URL');
assert(provisioning.includes('Recovered automatically'),'focused recovery must clearly say when no admin action remains');
assert(provisioning.includes('Within retry tolerance'),'focused recovery must explain when automatic retry is still the correct action');
assert(provisioning.includes('Needs intervention')||provisioning.includes('Intervention required'),'provisioning overview must distinguish intervention from background retry');

assert(admin.includes('item?.actionLabel'),'attention inbox must prefer source-specific next-step labels');
assert(admin.includes('Only current, persistent and operator-actionable conditions appear here.'),'attention inbox must explicitly define its low-noise contract');
assert(dashboard.includes('href="/admin/attention"')&&dashboard.includes('require review'),'dashboard hero must link its compact attention count to the canonical intervention queue without duplicating its explanatory copy');
assert(!dashboard.includes('Transient timeouts, automatic retries and recovered failures remain in diagnostics/history'),'focused Home must not reintroduce the retired standalone attention explanation');
assert(operator.includes('attention.openSummary()'),'Unread operator state must count the filtered live intervention queue');

console.log('attention workflow smoke: ok');
