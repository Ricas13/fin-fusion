'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};

const migration=read('db/migrations/015_marketing_campaign_scheduling.sql');
const campaigns=read('src/marketing/campaigns.js');
const admin=read('src/platform/admin-marketing.js');
const browser=read('public/js/admin-marketing-scheduling.js');
const jobs=read('src/automation/jobs.js');
const worker=read('scripts/automation-worker.js');

assert(migration.includes('scheduled_for timestamp with time zone'),'campaign schedule must be an absolute timestamptz');
assert(migration.includes("status IN ('draft','scheduled','queued','sent','cancelled')"),'scheduled state must be part of campaign status contract');
assert(migration.includes("WHERE status='scheduled'"),'due scheduled campaigns need a partial index');
assert(campaigns.includes('function scheduleTime(value)'),'campaign schedule validation missing');
assert(campaigns.includes('30 seconds in the future'),'campaigns must not accept already-due browser schedules');
assert(campaigns.includes("['draft','scheduled','queued'].includes"),'manual/worker queue must accept scheduled campaigns safely');
assert(campaigns.includes("status='scheduled' AND scheduled_for<=NOW()"),'worker due query must be database-time authoritative');
assert(campaigns.includes('schedule_attempts=schedule_attempts+1'),'scheduled queue failures must remain visible/retryable');
assert(campaigns.includes('No eligible opted-in recipients are available'),'scheduled campaigns must still re-evaluate current consent/audience at queue time');
assert(admin.includes("router.post('/admin/marketing/:id/schedule'"),'admin schedule route missing');
assert(admin.includes("router.post('/admin/marketing/:id/unschedule'"),'admin unschedule route missing');
assert(admin.includes('csrf.verify(req)'),'marketing schedule mutations must retain CSRF');
assert(admin.includes('storefrontUrl(req)')&&admin.includes("catch{return'';}"),'missing public base URL must not block campaign queueing');
assert(browser.includes('parsed.toISOString()'),'browser-local schedule must be converted to an explicit ISO instant');
assert(jobs.includes('async marketing_campaigns()'),'scheduled campaigns must use canonical automation job registry');
assert(jobs.includes('marketingCampaigns.runDue'),'automation job must delegate to campaign domain');
assert(worker.includes('marketing_campaigns:60'),'scheduled marketing job should run at one-minute cadence');
assert(!campaigns.includes('setInterval(')&&!admin.includes('setInterval('),'marketing must not create a second scheduler loop');

console.log('marketing scheduling smoke: ok');
