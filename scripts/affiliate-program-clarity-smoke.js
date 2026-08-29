'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const credits=read('src/affiliate-credits.js');
const admin=read('src/platform/admin-referrals.js');
const view=read('views/customer/affiliate.ejs');
const css=read('public/css/customer-affiliate.css');

assert(view.includes('/css/customer-affiliate.css'),'Affiliate page must load its dedicated spacing/layout stylesheet.');
assert(view.includes('When does it qualify?')&&view.includes('After their first eligible paid purchase'),'Customer affiliate page must state exactly when a referral qualifies.');
assert(view.includes('Signing up through your link records the referral')&&view.includes('does <strong>not</strong> earn credit by itself'),'Customer copy must distinguish referral attribution from reward qualification.');
assert(view.includes('A free-plan signup alone does not create a reward'),'Customer copy must explain that free signup alone does not earn affiliate credit.');
assert(view.includes('Service credit is not cash and cannot be withdrawn'),'Customer affiliate terms must not imply a cash payout.');
assert(view.includes('Qualified · pending')&&view.includes('Waiting for paid purchase'),'Customer referral history must distinguish qualification from pending attribution.');
assert(view.includes('state.referrals'),'Customer affiliate page must render the canonical referral activity returned by the credit owner.');
assert(css.includes('.affiliatePage{display:flex;flex-direction:column;gap:18px')&&css.includes('.affiliateOverview{display:grid'),'Affiliate page must have deliberate section spacing instead of relying on incidental shared styles.');
assert(css.includes('@media(max-width:700px)'),'Affiliate layout must retain readable spacing on mobile.');

assert(admin.includes('Future referral reward (%)'),'Admin settings must make clear that the programme percentage is prospective.');
assert(admin.includes('Historical rewards are immutable.')&&admin.includes('Top up to current rate'),'Admin affiliate page must explain historical correction semantics.');
assert(admin.includes('/admin/referrals/rewards/:creditId/top-up'),'Admin must expose a specific historical reward top-up route.');
assert(admin.includes('/admin/referrals/:customerId/adjust-credit'),'Admin must expose a manual signed credit-adjustment route.');
assert(admin.includes('majorToMinor(req.body.amount)'),'Manual admin adjustments must parse currency amounts into integer minor units.');
assert(credits.includes("entry_type='adjustment'")&&credits.includes("'admin.affiliate.credit.top_up'")&&credits.includes("'admin.affiliate.credit.adjustment'"),'Affiliate corrections must use separate adjustment ledger entries with audit actions.');
assert(credits.includes('sourceRewardId')&&credits.includes('targetRewardPercent'),'Historical top-ups must retain their original reward link and target programme rate.');
assert(credits.includes("if(row.state==='void')throw new Error('A reversed affiliate reward cannot be topped up.')"),'Reversed rewards must never be resurrected by a historical top-up.');
assert(credits.includes('This adjustment would remove more ${requested} credit than is currently spendable.'),'Manual negative adjustments must not create a negative spendable balance.');

console.log('affiliate programme clarity smoke: ok');
