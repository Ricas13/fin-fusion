'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const customerCreate = read('src/platform/admin-customer-create.js');
const genericActions = read('src/platform/admin-actions.js');
const requestActions = read('src/platform/admin-request-actions.js');
const storefrontActions = read('src/platform/admin-storefront-settings-actions.js');
const entitlementWrite = read('src/entitlements/admin-grants.js');

assert(customerCreate.includes("router.get('/admin/users/new'"));
assert(customerCreate.includes("router.post('/admin/users/new'"));
assert(customerCreate.includes("require('../entitlements/admin-grants')"));
assert(customerCreate.includes('createAdminGrantByPlanCodeTx'));
assert(!/INSERT\s+INTO\s+subscriptions/i.test(customerCreate));
assert(!/FROM\s+plans/i.test(customerCreate));
assert(!genericActions.includes("'/admin/users/new'"));
assert(!/INSERT\s+INTO\s+subscriptions/i.test(genericActions));
assert(/FROM\s+plans/i.test(entitlementWrite));
assert(/INSERT\s+INTO\s+subscriptions/i.test(entitlementWrite));
assert(entitlementWrite.includes("audience IN('direct','both')"));
assert(entitlementWrite.includes("'subscription.admin_grant'"));

// The historical generic admin-actions entry point is composition-only. Request
// and storefront writes have explicit owners, so unrelated admin workflows do
// not share one SQL/CSRF catch-all module.
assert(genericActions.includes('createAdminRequestActionsRouter()'));
assert(genericActions.includes('createAdminStorefrontSettingsActionsRouter()'));
assert(!genericActions.includes("require('../db')"));
assert(!genericActions.includes("require('../auth/csrf')"));
assert(!/\.post\(/.test(genericActions));

assert(requestActions.includes("router.post('/admin/requests/:id'"));
assert(requestActions.includes('csrf.verify(req)'));
assert(requestActions.includes('UPDATE content_requests'));
assert(requestActions.includes("'admin.request.update'"));
assert(requestActions.includes("['pending', 'approved', 'declined', 'searching', 'available', 'failed']"));

assert(storefrontActions.includes("router.post('/admin/settings/storefront'"));
assert(storefrontActions.includes('csrf.verify(req)'));
assert(storefrontActions.includes("VALUES('storefront'"));
assert(storefrontActions.includes("VALUES('storefront_features'"));
assert(storefrontActions.includes("'admin.storefront.update'"));

console.log('customer/admin action ownership: ok');
