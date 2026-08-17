'use strict';

const fs=require('fs');
const path=require('path');

const root=path.resolve(__dirname,'..');
function read(file){return fs.readFileSync(path.join(root,file),'utf8')}
function requireText(file,needle,message){if(!read(file).includes(needle))throw new Error(`${message} (${file})`)}
function forbid(file,pattern,message){if(pattern.test(read(file)))throw new Error(`${message} (${file})`)}

const liveResellerFiles=[
  'src/platform/admin-reseller-tiers.js',
  'src/platform/admin-resellers.js',
  'src/platform/admin-reseller-360.js',
  'src/platform/admin-reseller-settings.js',
  'src/platform/reseller-service-aware-portal.js',
  'src/platform/reseller-business.js',
  'src/platform/reseller-export.js',
  'src/platform/admin-commerce.js'
];

for(const file of liveResellerFiles){
  forbid(file,/Reseller credit cost|resellerCreditCost|reseller_trial_credit_cost|reseller_credit_cost/i,'Live reseller UI must not expose legacy credit pricing');
  forbid(file,/Credit balance|Trial credits|Legacy credits|Record sale|Revenue MTD|ledger currency|allowed payment methods/i,'Live reseller UI must not expose the retired reseller sales/ledger model');
  forbid(file,/\breseller_sales\b/i,'Live reseller runtime must not read or write downstream reseller sales');
}

forbid('src/platform/router.js',/createResellerLedgerRouter|reseller-ledger|\/reseller\/sales[^\n]*\/reseller\/ledger/i,'Shared router must not mount the retired reseller ledger');
forbid('src/platform/admin-plan-payment-options.js',/resellerCreditCost|resellerTrialCreditCost|reseller_credit_cost|reseller_trial_credit_cost/i,'Customer-plan commerce must not contain reseller credit pricing');
forbid('src/platform/admin-plans.js',/resellerCreditCost|resellerTrialCreditCost|reseller_credit_cost|reseller_trial_credit_cost|Legacy reseller credits/i,'Customer-plan administration/export must not contain reseller credit pricing');
forbid('src/platform/admin-plan-create-v2.js',/name="audience"|Direct \+ resellers|>Resellers</i,'New customer plans must not offer reseller audience modes');

requireText('db/migrations/084_reseller_managed_seat_policy.sql','ADD COLUMN IF NOT EXISTS reseller_managed','Reseller-owned users need an explicit managed-seat identity');
requireText('db/migrations/084_reseller_managed_seat_policy.sql','ADD COLUMN IF NOT EXISTS allow_video_transcoding','Reseller tier must own Jellyfin video-transcoding policy');
requireText('db/migrations/084_reseller_managed_seat_policy.sql','ADD COLUMN IF NOT EXISTS library_access_mode','Reseller tier must own Jellyfin library policy');
requireText('src/resellers/managed-users.js','reseller_managed=TRUE','Managed-user creation must consume reseller seats directly');
requireText('src/resellers/managed-users.js','Delete an unused user or upgrade the reseller plan','Seat admission must fail closed when the reseller allowance is full');
requireText('src/resellers/managed-users.js',"method:'DELETE'",'Deleting a managed seat must delete the corresponding Jellyfin account');
requireText('src/entitlements/subscription-state.js','managedResellerEntitlement','Managed reseller users must resolve access from the parent reseller tier');
requireText('src/payments/reseller-billing.js','managedUsers.seatUsage','Tier downgrade safety must use actual managed Jellyfin users');
requireText('src/platform/admin-reseller-tiers.js','Concurrent streams per managed user','Reseller plan setup must expose per-user stream policy');
requireText('src/platform/admin-reseller-tiers.js','Jellyfin user policy','Reseller plan setup must use the familiar Jellyfin policy section');
requireText('src/platform/admin-reseller-tiers.js','Jellyfin libraries','Reseller plan setup must expose library selection');

requireText('db/migrations/085_canonical_free_tier.sql','is_free_tier BOOLEAN NOT NULL DEFAULT FALSE','A canonical free-tier marker must exist');
requireText('db/migrations/085_canonical_free_tier.sql','plans_single_free_tier_idx','Exactly one canonical free tier must be enforced');
requireText('db/migrations/085_canonical_free_tier.sql','The canonical free plan cannot be deleted','The free tier must be protected from deletion');
requireText('src/platform/storefront.js','freeTierPanel','The homepage must render Free Access separately from normal cards');
requireText('src/platform/storefront.js','Permanent free tier','The free tier must visibly stand out on the homepage');
requireText('src/platform/admin-plans.js','The permanent Free Access plan cannot be archived','Admin plan editing must protect the permanent free tier');
requireText('src/platform/admin-plan-payment-options.js','Permanent free tier · always enabled at zero','Free-tier currency prices must be visibly locked at zero');

requireText('src/platform/admin-plan-order.js','data-order-list','Storefront ordering must expose sortable product groups');
requireText('src/platform/admin-plan-order.js',"UPDATE plans SET sort_order",'Customer/Stremio plan order must persist');
requireText('src/platform/admin-plan-order.js',"UPDATE reseller_tiers SET sort_order",'Reseller plan order must persist');
requireText('public/js/admin-plan-order.js','dragstart','Storefront order must support drag-and-drop');
requireText('public/js/admin-plan-order.js',"data-move",'Storefront order must also support explicit up/down controls');
requireText('src/platform/admin-plans-list.js',"limit===0",'Zero customer capacity must render as a deliberate closed state');
requireText('src/platform/admin-plans-list.js',"n<0",'Reseller storefront availability must accept zero but reject negatives');

console.log('reseller seat model: ok');
