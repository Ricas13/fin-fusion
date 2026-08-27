'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const dashboard=read('src/platform/customer-dashboard.js');
const cleanup=read('src/entitlements/jellyfin-cleanup-return.js');

const getStart=dashboard.indexOf("r.get('/account',requireCustomer");
const retryStart=dashboard.indexOf("r.post('/account/provisioning/retry',requireCustomer");
assert(getStart>=0&&retryStart>getStart,'customer dashboard GET and retry POST must both exist');
const getBlock=dashboard.slice(getStart,retryStart);
const retryBlock=dashboard.slice(retryStart);

assert(getBlock.includes('cleanupReturn.returningCustomerStatus(customerId)'),'GET /account must inspect restoration eligibility through the read-only helper');
assert(!getBlock.includes('cleanupReturn.restoreReturningCustomer'),'GET /account must never release cleanup/inactivity holds');
assert(!getBlock.includes('provisioning.reconcileCustomer('),'GET /account must never reconcile a remote Jellyfin account');
assert(getBlock.includes("returnStatus.eligible&&req.query.skipRestore!=='1'"),'restorable access must require an explicit restore decision rather than page-load mutation');
assert(getBlock.includes('returningAccessPage(req,returnStatus)'),'restorable access must render the explicit restoration confirmation');
assert(dashboard.includes('Opening this page did not change your account or contact Jellyfin.'),'restoration confirmation must explain the read-only boundary');
assert(dashboard.includes('method="post" action="/account/provisioning/retry"'),'restoration confirmation must submit through the existing mutation endpoint');
assert(dashboard.includes('href="/account?skipRestore=1"'),'customers must be able to continue to the account without restoring access');

const csrfIndex=retryBlock.indexOf('csrf.verify(req)');
const restoreIndex=retryBlock.indexOf('cleanupReturn.restoreReturningCustomer');
assert(csrfIndex>=0&&restoreIndex>csrfIndex,'restoration must occur only after the retry POST passes CSRF verification');
assert(retryBlock.includes('reconcile:provisioning.reconcileCustomer'),'explicit restoration must still request Jellyfin reprovisioning');
assert(retryBlock.includes('provisioning.reconcileCustomer(customerId)'),'ordinary retry must continue to reconcile customers without restoration state');

const inspectStart=cleanup.indexOf('async function returningCustomerStatus');
const mutateStart=cleanup.indexOf('async function restoreReturningCustomer');
assert(inspectStart>=0&&mutateStart>inspectStart,'cleanup-return service must separate inspection from mutation');
const inspectBlock=cleanup.slice(inspectStart,mutateStart);
assert(!inspectBlock.includes('releaseHold('),'read-only restoration inspection must not release access holds');
assert(!inspectBlock.includes('UPDATE jellyfin_account_lifecycle'),'read-only restoration inspection must not mutate lifecycle history');
assert(!inspectBlock.includes('INSERT INTO audit_log'),'read-only restoration inspection must not append mutation audit events');
assert(cleanup.slice(mutateStart).includes('await returningCustomerStatus(customerId)'),'restoration mutation must re-check eligibility instead of trusting stale GET state');

console.log('customer dashboard read-only GET smoke: ok');
