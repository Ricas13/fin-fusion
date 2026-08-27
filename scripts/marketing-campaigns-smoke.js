'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const exists=file=>fs.existsSync(path.join(root,file));

const composition=read('src/platform/admin-route-composition.js');
const nav=read('src/platform/admin-nav.js');
const communications=read('views/customer/communications.ejs');
const communicationsRouter=read('src/platform/customer-communications.js');
const jobs=read('src/automation/jobs.js');
const automationLabels=read('src/platform/admin-automation.js');
const campaigns=read('src/marketing/campaigns.js');
const customerFilters=read('src/platform/customer-filters.js');
const migrationFiles=fs.readdirSync(path.join(root,'db/migrations'));
const marketingMigrationFile=migrationFiles.find(f=>read(`db/migrations/${f}`).includes('discount_code_id uuid REFERENCES discount_codes(id)'));
assert(marketingMigrationFile,'a migration adding discount_code_id to marketing_campaigns must exist');
const migration=read(`db/migrations/${marketingMigrationFile}`);
const historicalCampaignMigration=read('db/migrations/013_marketing_campaigns.sql');

assert(composition.includes('admin-marketing')&&composition.includes('createAdminMarketingRouter'),'admin Marketing router must be required and mounted');
assert(/app\.use\(createAdminMarketingRouter\(\)\)/.test(composition),'admin Marketing router must be composed onto the app');

assert(nav.includes("['marketing','Marketing','/admin/marketing']"),'Marketing must appear in admin navigation');

assert(communicationsRouter.includes('/account/communications/marketing-email'),'customer portal must expose a marketing consent route');
assert(communications.includes('/account/communications/marketing-email'),'customer notifications page must render the marketing consent form');
assert(communications.includes('Offers'),'customer notifications page must label the marketing consent control');

assert(jobs.includes('marketing_campaigns'),'automation registry must run due marketing campaigns');
assert(automationLabels.includes('marketing_campaigns'),'automation dashboard must label the marketing_campaigns job');

for(const file of [
  'src/platform/admin-marketing.js',
  'src/marketing/campaigns.js'
])assert(exists(file),`Marketing file must exist: ${file}`);

// migration 013 created marketing_campaigns/marketing_campaign_recipients and migration 018
// only ever deleted their automation_job_state row (never the tables), so on every
// install those tables already exist with 013's original shape (free-text discount_code,
// a fixed segment_key enum). The rebuild must reconcile that pre-existing shape via ALTER,
// not silently no-op a CREATE TABLE IF NOT EXISTS against it.
assert(historicalCampaignMigration.includes('CREATE TABLE marketing_campaigns'),'historical migration 013 must still create the original marketing_campaigns table');
assert(migration.includes('ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS discount_code_id'),'migration must reconcile the pre-existing marketing_campaigns table with an added discount_code_id column');
assert(migration.includes('DROP COLUMN IF EXISTS discount_code'),'migration must drop the old free-text discount_code column');
assert(migration.includes('DROP COLUMN IF EXISTS segment_key'),'migration must drop the old segment_key enum column');
assert(migration.includes('CREATE TABLE IF NOT EXISTS marketing_campaign_deliveries'),'migration must create the genuinely new marketing_campaign_deliveries table');
assert(migration.includes('discount_code_id uuid REFERENCES discount_codes(id)'),'marketing_campaigns must FK to discount_codes');
assert(migration.includes('audience_filters jsonb'),'marketing_campaigns must store audience filters as jsonb');
assert(migration.includes('ALTER COLUMN email_snapshot DROP NOT NULL'),'marketing_campaign_recipients must allow a recipient with no email on file');

assert(campaigns.includes("channel==='email'"),'campaigns module must support email delivery');
assert(campaigns.includes("channel==='discord'"),'campaigns module must support discord delivery');
assert(campaigns.includes("channel==='telegram'"),'campaigns module must support telegram delivery');
assert(campaigns.includes("channel==='whatsapp'"),'campaigns module must support whatsapp delivery');
assert(campaigns.includes('marketing_opt_in'),'campaigns module must gate sends on customer marketing consent');

assert(customerFilters.includes('isFreeTier'),'customer-filters must expose an isFreeTier audience filter');

assert(!exists('scripts/marketing-retirement-smoke.js'),'the retired marketing-retirement-smoke guard must be removed now that Marketing is rebuilt');

console.log('marketing campaigns smoke: ok');
