'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const exists=file=>fs.existsSync(path.join(root,file));

const migration=read('db/migrations/027_marketing_control_centre.sql');
const historicalCampaignMigration=read('db/migrations/013_marketing_campaigns.sql');
const historicalScheduleMigration=read('db/migrations/015_marketing_campaign_scheduling.sql');
const service=read('src/marketing/campaigns.js');
const admin=read('src/platform/admin-marketing.js');
const composition=read('src/platform/admin-route-composition.js');
const nav=read('src/platform/admin-nav.js');
const customer=read('src/platform/customer-communications.js');
const customerView=read('views/customer/communications.ejs');
const jobs=read('src/automation/jobs.js');
const worker=read('scripts/automation-worker.js');
const packageJson=read('package.json');

// Historical migrations are immutable; the restored product extends them in a
// new migration instead of rewriting deployed migration history.
assert(historicalCampaignMigration.includes('CREATE TABLE marketing_campaigns'),'historical campaign schema must remain present');
assert(historicalCampaignMigration.includes('marketing_email_opt_in boolean DEFAULT false NOT NULL'),'marketing consent must remain explicit and default off');
assert(historicalScheduleMigration.includes('scheduled_for'),'historical campaign scheduling migration must remain present');
for(const contract of ['ADD COLUMN IF NOT EXISTS segment_rules','CREATE TABLE IF NOT EXISTS marketing_segments','CREATE TABLE IF NOT EXISTS marketing_templates','active_subscription','segment_id uuid REFERENCES marketing_segments','template_id uuid REFERENCES marketing_templates'])assert(migration.includes(contract),`Marketing control-centre migration missing ${contract}`);

// Audience selection is a server-owned rule builder with bounded/whitelisted
// values. Operators never submit SQL and preview returns only an aggregate.
for(const rule of ['accountAgeDays','lapsedDays','expiresWithinDays','inactivePlaybackDays','serviceType','priceType','subscriptionStatus','billingInterval','planId'])assert(service.includes(rule),`Marketing audience rule missing ${rule}`);
assert(service.includes("cp.marketing_email_opt_in=TRUE"),'all Marketing audiences must require current explicit opt-in');
assert(service.includes("NULLIF(TRIM(c.email),'')")&&service.includes("NULLIF(TRIM(u.email),'')"),'Marketing must use canonical customer/app-user email identity');
assert(!service.includes('c.login_email')&&!service.includes('c.login_username'),'retired customer login columns must not return');
assert(service.includes('SELECT COUNT(*)::int count'),'audience preview must be count-only');
assert(service.includes("params.push(value); return `$${params.length}`"),'dynamic audience values must use positional SQL parameters');

// Delivery stays on the encrypted, retrying outbox and eligibility is checked
// again immediately before queueing a recipient.
assert(service.includes("outbox.enqueue({ type: 'marketing_campaign'"),'campaign delivery must reuse the existing email outbox');
assert(service.includes('dedupeKey: `marketing:${data.campaign.id}:${recipient.customer_id}`'),'campaign delivery must be idempotent per customer');
assert(!service.includes('emailSettings.send'),'Marketing must not introduce a second direct SMTP delivery engine');
assert(service.includes("reason = 'opted_out_before_send'")&&service.includes("reason = 'no_longer_eligible'"),'queue-time consent and audience drift must suppress recipients');
assert(service.includes("type: 'marketing_campaign_test'"),'operator test email must also go through the normal outbox');
assert(service.includes("status='scheduled'")&&service.includes('schedule_next_attempt_at'),'scheduled campaigns must remain database-authoritative');

// The admin surface is a real four-page Marketing area with CSRF-protected
// mutations and no PII-bearing audience preview response.
for(const route of ["router.get('/admin/marketing'","router.get('/admin/marketing/campaigns'","router.get('/admin/marketing/segments'","router.get('/admin/marketing/templates'"])assert(admin.includes(route),`Marketing admin route missing ${route}`);
for(const post of ["router.post('/admin/marketing/campaigns'","router.post('/admin/marketing/campaigns/test'","router.post('/admin/marketing/:id/queue'","router.post('/admin/marketing/:id/schedule'","router.post('/admin/marketing/segments'","router.post('/admin/marketing/templates'"])assert(admin.includes(post),`Marketing mutation missing ${post}`);
assert((admin.match(/csrf\.verify\(req\)/g)||[]).length>=9,'Marketing mutations must verify CSRF');
assert(admin.includes("return res.json({ ok: true, count: result.count })"),'audience preview must expose only the aggregate count');
assert(!admin.includes('sample:')&&!admin.includes('recipient_email'),'audience preview/admin builder must not expose a recipient sample');
assert(composition.includes("require('./admin-marketing')")&&composition.includes('createAdminMarketingRouter()'),'Marketing router must be composed once');
assert(nav.includes("{key:'marketing',label:'Marketing'")&&nav.includes("['marketing-overview','Overview','/admin/marketing']")&&nav.includes("['marketing-campaigns','Campaigns','/admin/marketing/campaigns']")&&nav.includes("['marketing-segments','Segments','/admin/marketing/segments']")&&nav.includes("['marketing-templates','Templates','/admin/marketing/templates']"),'Marketing must be a top-level four-page admin group');

// Promotional consent is clearly separate from mandatory transactional email.
assert(customer.includes("/account/communications/marketing-email")&&customer.includes('marketing_email_opt_in'),'customer portal must own explicit Marketing consent');
assert(customer.includes("customer.marketing_email.preference"),'Marketing preference changes must be audited');
assert(customerView.includes('Offers &amp; discounts by email'),'customer portal must expose understandable Marketing consent');
assert(customerView.includes('separate from important account, security and payment email'),'customer portal must distinguish promotional from transactional email');

// Scheduled campaigns rejoin the canonical automation worker rather than
// creating a second scheduler.
assert(jobs.includes("const marketingCampaigns=require('../marketing/campaigns')")&&jobs.includes('async marketing_campaigns()'),'Marketing scheduling must use the canonical job registry');
assert(worker.includes('marketing_campaigns:60'),'Marketing campaigns must be checked every minute by the canonical worker');
assert(packageJson.includes('node scripts/marketing-control-centre-smoke.js'),'fast checks must cover restored Marketing');
assert(!packageJson.includes('node scripts/marketing-retirement-smoke.js'),'retirement smoke must not remain in the active check suite');
assert(!exists('src/platform/customer-marketing-preferences.js'),'Marketing consent must stay in the canonical customer communications router');

console.log('marketing control centre smoke: ok');
