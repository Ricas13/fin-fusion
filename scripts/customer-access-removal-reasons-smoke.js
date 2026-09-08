'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const ended=require('../src/platform/customer-access-ended');

const firstPlay=ended.inactivityReason({metadata:{triggers:['no first Free Server playback within 3 day(s) of this allocation']}});
assert.equal(firstPlay,'Free Server access was removed because you did not play anything within 3 days of receiving or restoring your place.','first-play removal must tell the customer the exact three-day reason');

const retention=ended.inactivityReason({metadata:{triggers:['no Free Server playback for 7 day(s)','12 min played on Free Server in 7 day(s), below 30 min']}});
assert.equal(retention,'Free Server access was removed because both ongoing rules were missed: there was no playback for 7 days and only 12 minutes were watched in the 7-day window (minimum 30 minutes).','retention removal must explain both failed ongoing rules');

assert.equal(
  ended.inactiveReason({status:'expired',billing_mode:'subscription',price_minor_snapshot:600},null),
  'Your paid access ended because the subscription was not successfully renewed.',
  'an expired paid subscription must explain failed/non-renewal rather than generic inactivity'
);
assert.equal(
  ended.inactiveReason({status:'refunded',price_minor_snapshot:600},null),
  'Access ended because the payment was refunded.',
  'refund removal must be identified explicitly'
);
assert.equal(
  ended.inactiveReason({status:'cancelled',price_minor_snapshot:600},null),
  'Your subscription was cancelled and this access is no longer active.',
  'customer cancellation must remain distinct from non-payment'
);
assert.equal(
  ended.inactiveReason({status:'past_due',price_minor_snapshot:600},{hold_type:'payment_delinquency'}),
  'Access ended because payment could not be collected.',
  'payment-delinquency holds must identify non-payment explicitly'
);
assert.equal(
  ended.inactiveReason({status:'expired',billing_interval_snapshot:'trial'},null),
  'Your trial ended.',
  'trial expiry must not be described as non-payment'
);

const router=read('src/platform/router.js');
const source=read('src/platform/customer-access-ended.js');
const view=read('views/customer/access-ended.ejs');
const client=read('public/js/customer-jellyfin.js');
assert(router.indexOf('createCustomerAccessEndedRouter()')<router.indexOf('createCustomerJellyfinRouter()'),'access-ended router must run before the existing My Access router so ended paid users are not redirected away');
assert.match(source,/router\.get\('\/account\/access-history\.json'/,'customer access history JSON must be exposed from the canonical reason layer');
assert.match(source,/if\(liveMediaSubscriptions\(portal\)\.length\)return next\(\)/,'active customers must continue into the normal My Access router');
assert.match(source,/return res\.render\('customer\/access-ended'/,'customers with no live streaming service but recorded history must see a reason page');
assert.match(view,/Why your access ended/,'ended-access page must explain why access ended');
assert.match(view,/portal account available even when streaming access has ended/,'ended-access page must make clear that the portal account remains available');
assert.match(client,/fetch\('\/account\/access-history\.json'/,'normal My Access must fetch access-ended history');
assert.match(client,/Free Server access removed/,'normal My Access must replace the old generic inactivity heading');
assert.match(client,/Why previous access ended/,'normal My Access must show reason history when other services remain active');

console.log('customer access removal reasons smoke: ok');
