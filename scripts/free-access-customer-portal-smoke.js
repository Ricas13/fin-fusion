'use strict';

const assert = require('assert');
const fs = require('fs');

const provision = fs.readFileSync('src/jellyfin/provisioning-core.js', 'utf8');
const dash = fs.readFileSync('src/platform/customer-dashboard.js', 'utf8');
const view = fs.readFileSync('views/customer/dashboard.ejs', 'utf8');

assert(/accessKind\s*=\s*isTrial\s*\?\s*['"]trial['"]/.test(provision), 'placement must classify trial/free/paid');
assert(/\$2::text='free'\s+THEN TRUE/.test(provision), 'free access must not require paid_enabled');
assert(/getCustomerState\(req\.session\.customerId\)/.test(dash), 'customer dashboard must expose provisioning state');
assert(/\/account\/provisioning\/retry/.test(dash), 'customer must have provisioning retry route');
assert(/customerSidebar/.test(view) && /Notifications/.test(view) && /Affiliate programme/.test(view) && /Security/.test(view), 'customer left navigation missing');
assert(/accessWelcomeBackdrop/.test(view) && /You now have Jellyfin access/.test(view), 'large access onboarding modal missing');
assert(/primaryAccount\.public_url/.test(view) && /primaryAccount\.jellyfin_username/.test(view), 'onboarding must show server URL and Jellyfin username');
assert(/provisioningState\.last_error/.test(view), 'customer provisioning failure reason missing');

console.log('free access customer portal smoke: ok');
