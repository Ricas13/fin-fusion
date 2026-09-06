'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const route=read('src/platform/customer-jellyfin.js');
const view=read('views/customer/jellyfin.ejs');

assert.match(route,/jellyfin-cleanup-return/,'My Access must consult the canonical returning-customer inactivity state');
assert.match(route,/cleanupReturn\.returningCustomerStatus\(customerId\)/,'My Access must resolve intentional inactivity removal before rendering subscriptions');
assert.match(route,/function markRemovedFreeAccess\(/,'My Access must decorate retained Free Server entitlements that were intentionally removed');
assert.match(route,/access_removed:true,access_removed_reason:'inactivity'/,'inactivity-removed Free Server access must carry an explicit non-active presentation state');
assert.match(route,/const subscriptions=markRemovedFreeAccess\(rawSubscriptions,returnStatus\)/,'the decorated subscription state must be the state rendered by My Access');
assert.match(route,/returnStatus,/,'the view must receive restoration state for the removed Free Server profile');

assert.match(view,/activeSubscriptions=accessRows\.filter\(subscription=>!subscription\.access_removed\)/,'active access must exclude intentionally removed subscriptions');
assert.match(view,/removedSubscriptions=accessRows\.filter\(subscription=>subscription\.access_removed\)/,'removed access must be rendered separately');
assert.match(view,/Removed for inactivity/,'removed Free Server access must never be labelled Active');
assert.match(view,/Free Server access removed for inactivity/,'My Access must explain why Free Server access ended');
assert.match(view,/It is not active and is not waiting for normal provisioning/,'intentional inactivity removal must not be presented as a provisioning failure');
assert.match(view,/Restore Free Server access/,'a retained Free Server entitlement must offer explicit restoration');
assert.match(view,/method="post" action="\/account\/provisioning\/retry"/,'restoration must reuse the existing guarded provisioning retry mutation');
assert.match(view,/if\(!accounts\.length&&hasPendingMediaAccess\)/,'generic provisioning UI must only appear when current active media access is genuinely missing an account');
assert.match(view,/hasPendingMediaAccess=activeSubscriptions\.some/,'removed Free Server access must not make generic provisioning appear pending');

console.log('customer My Access inactivity smoke: ok');
