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
const adminMarketing=read('src/platform/admin-marketing.js');
const campaigns=read('src/marketing/campaigns.js');
const segments=read('src/marketing/segments.js');
const customerFilters=read('src/platform/customer-filters.js');
const migrationFiles=fs.readdirSync(path.join(root,'db/migrations'));
const marketingMigrationFile=migrationFiles.find(f=>read(`db/migrations/${f}`).includes('discount_code_id uuid REFERENCES discount_codes(id)'));
assert(marketingMigrationFile,'a migration adding discount_code_id to marketing_campaigns must exist');
const migration=read(`db/migrations/${marketingMigrationFile}`);
const segmentMigrationFile=migrationFiles.find(f=>read(`db/migrations/${f}`).includes('CREATE TABLE IF NOT EXISTS marketing_segments'));
assert(segmentMigrationFile,'a migration creating saved marketing segments must exist');
const segmentMigration=read(`db/migrations/${segmentMigrationFile}`);
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
  'src/marketing/campaigns.js',
  'src/marketing/segments.js'
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

// Saved segments extend the current audience_filters architecture. Campaigns keep
// a nullable source reference but always retain their own immutable filter snapshot.
assert(segmentMigration.includes('marketing_segments'),'saved segments need a durable table');
assert(segmentMigration.includes("jsonb_typeof(audience_filters)='object'"),'saved segment filters must be JSON objects');
assert(segmentMigration.includes('marketing_segments_name_unique_idx'),'saved segment names must be unique case-insensitively');
assert(segmentMigration.includes('segment_id uuid REFERENCES marketing_segments(id) ON DELETE SET NULL'),'campaigns may reference a segment without depending on it for future delivery');
assert(campaigns.includes("savedSegment=await segments.get(segmentId)"),'campaign creation must resolve the selected saved segment');
assert(campaigns.includes('filters=segments.normalizeFilters(savedSegment.audience_filters||{})'),'campaign creation must normalize the selected segment');
assert(campaigns.includes('JSON.stringify(filters),savedSegment?.id||null'),'campaign creation must copy filters and retain only a nullable source reference');
assert(campaigns.includes('async function preview(audienceFilters){const rows=await eligibleCustomers(audienceFilters);return{count:rows.length};}'),'marketing audience preview must be aggregate-only');
assert(!campaigns.includes('sample:rows.slice'),'marketing audience preview must never expose recipient samples');

for(const rule of ['service','planId','status','priceType','billingInterval','accountAgeDays','lapsedDays','expiresWithinDays','inactivePlaybackDays']){
  assert(segments.includes(rule),`saved segment validation must support ${rule}`);
}
assert(segments.includes('marketing.segment.create')&&segments.includes('marketing.segment.update')&&segments.includes('marketing.segment.delete'),'saved segment mutations must be audited');
assert(adminMarketing.includes("router.post('/admin/marketing/segments', marketingWriteLimit"),'saved segment creation must be explicitly rate-limited');
assert(adminMarketing.includes("router.post('/admin/marketing/segments/:id', marketingWriteLimit"),'saved segment updates must be explicitly rate-limited');
assert(adminMarketing.includes("router.post('/admin/marketing/segments/:id/delete', marketingWriteLimit"),'saved segment deletion must be explicitly rate-limited');
assert(adminMarketing.includes('Counts are live and aggregate-only'),'admin Marketing must explain count-only segment previews');
assert(adminMarketing.includes('A selected saved segment overrides the one-off fields below and is copied into the campaign as a snapshot.'),'campaign composer must explain saved-segment snapshot behavior');

assert(campaigns.includes("channel==='email'"),'campaigns module must support email delivery');
assert(campaigns.includes("channel==='discord'"),'campaigns module must support discord delivery');
assert(campaigns.includes("channel==='telegram'"),'campaigns module must support telegram delivery');
assert(campaigns.includes("channel==='whatsapp'"),'campaigns module must support whatsapp delivery');
assert(campaigns.includes('marketing_opt_in'),'campaigns module must gate sends on customer marketing consent');
assert(campaigns.includes('currentConsent'),'campaign queueing must re-check consent at send time');

assert(customerFilters.includes('isFreeTier'),'customer-filters must retain the historical isFreeTier audience filter');
for(const rule of ['PRICE_TYPES','BILLING_INTERVALS','accountAgeDays','lapsedDays','expiresWithinDays','inactivePlaybackDays']){
  assert(customerFilters.includes(rule),`shared customer filters must support ${rule}`);
}

assert(!exists('scripts/marketing-retirement-smoke.js'),'the retired marketing-retirement-smoke guard must be removed now that Marketing is rebuilt');

console.log('marketing campaigns smoke: ok');
