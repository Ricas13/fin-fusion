'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const customerCreate = read('src/platform/admin-customer-create.js');
const genericActions = read('src/platform/admin-actions.js');
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

console.log('customer create ownership: ok');
