'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const exists=file=>fs.existsSync(path.join(root,file));

const composition=read('src/platform/admin-route-composition.js');
const router=read('src/platform/router.js');
const nav=read('src/platform/admin-nav.js');
const customer360=read('src/platform/admin-customer-360.js');
const communications=read('views/customer/communications.ejs');
const jobs=read('src/automation/jobs.js');
const worker=read('scripts/automation-worker.js');
const retireMigration=read('db/migrations/018_retire_marketing_runtime.sql');
const historicalCampaignMigration=read('db/migrations/013_marketing_campaigns.sql');
const historicalScheduleMigration=read('db/migrations/015_marketing_campaign_scheduling.sql');

assert(!composition.includes('admin-marketing')&&!composition.includes('createAdminMarketingRouter'),'retired admin Marketing router must not be composed');
assert(!router.includes('customer-marketing-preferences')&&!router.includes('createCustomerMarketingPreferencesRouter'),'retired customer marketing preference router must not be mounted');
assert(!nav.includes("['marketing','Marketing','/admin/marketing']")&&!nav.includes('marketing:Object.freeze'),'Marketing must not remain in admin navigation context');
assert(!communications.includes('/account/communications/marketing-email'),'customer portal must not expose retired marketing consent controls');
assert(!communications.includes('Offers &amp; discounts by email')&&!communications.includes('marketing_email_opt_in'),'customer notifications page must not advertise retired Marketing');
assert(!customer360.includes('/marketing/withdraw')&&!customer360.includes('Marketing consent')&&!customer360.includes('marketingConsentChanged'),'Customer 360 must not retain Marketing controls, routes or mutation metadata');
assert(!jobs.includes('marketingCampaigns')&&!jobs.includes('marketing_campaigns'),'automation registry must not run retired marketing campaigns');
assert(!worker.includes('marketing_campaigns'),'automation worker must not schedule retired marketing campaigns');
assert(retireMigration.includes("DELETE FROM public.automation_job_state")&&retireMigration.includes("job_key='marketing_campaigns'"),'upgrade migration must remove stale Marketing from Operations → Jobs');

for(const file of [
  'src/platform/admin-marketing.js',
  'src/platform/customer-marketing-preferences.js',
  'src/marketing/campaigns.js',
  'public/js/admin-marketing-scheduling.js',
  'scripts/marketing-campaigns-smoke.js',
  'scripts/marketing-scheduling-smoke.js'
])assert(!exists(file),`retired Marketing file must be removed: ${file}`);

assert(historicalCampaignMigration.includes('CREATE TABLE marketing_campaigns'),'historical Marketing schema migration must remain immutable for existing deployments');
assert(historicalScheduleMigration.includes('scheduled_for'),'historical Marketing scheduling migration must remain immutable for migration checksums');

console.log('marketing retirement smoke: ok');
