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

// Admin impersonation is a separate read-only boundary: only an active owner
// may enter it, and once entered every unsafe customer /account mutation is
// denied centrally before payment/security/subscription routers can run.
const impersonationSource=read('src/platform/admin-impersonation.js');
const ownerGuardSource=read('src/auth/owner-guard.js');
const application=read('src/application.js');
const {restrictedImpersonationAction,wantsJson}=require('../src/platform/admin-impersonation');
assert(impersonationSource.includes("const { requireOwner, ownerStatus } = require('../auth/owner-guard');"),'impersonation must use the canonical owner capability service');
assert(impersonationSource.includes("router.post('/admin/users/:customerId/impersonate', gate, requireOwner"),'support administrators must not be able to start customer impersonation');
assert(impersonationSource.includes('if (!await ownerStatus(req.session.authUserId)) return next();'),'Customer 360 must hide the impersonation action from support-only administrators');
assert(ownerGuardSource.includes('COALESCE(is_owner,FALSE) AS is_owner')&&ownerGuardSource.includes("user.role === 'admin' && user.active && user.is_owner"),'owner authorization must be database-backed, active, and fail closed');
assert(/row\?\.role === 'customer'/.test(impersonationSource),'privileged/admin identities must never be impersonation targets');

const impersonated=(method,pathname)=>({session:{impersonation:{id:'test'}},method,path:pathname});
for(const method of ['POST','PUT','PATCH','DELETE']){
    for(const pathname of ['/account/profile','/account/security/password','/account/checkout/stripe','/account/stremio/install','/account/provisioning/retry']){
        assert.strictEqual(restrictedImpersonationAction(impersonated(method,pathname)),'customer changes',`impersonation must block ${method} ${pathname}`);
    }
}
for(const method of ['GET','HEAD','OPTIONS'])assert.strictEqual(restrictedImpersonationAction(impersonated(method,'/account')),null,`${method} browsing must remain available while impersonating`);
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/impersonation/exit')),null,'audited impersonation exit must remain available');
assert.strictEqual(restrictedImpersonationAction({session:{},method:'POST',path:'/account/checkout/stripe'}),null,'normal customer sessions must not be affected by impersonation policy');
assert.strictEqual(wantsJson({headers:{accept:'application/json'}}),true,'API-style impersonation denials must support structured JSON responses');
assert.strictEqual(wantsJson({headers:{accept:'text/html'}}),false,'normal browser denials must remain HTML/text responses');
assert(impersonationSource.includes("error:'impersonation_read_only'")&&impersonationSource.includes('Payments and account-changing actions are disabled.'),'blocked impersonation writes must return a stable read-only error contract');
assert(impersonationSource.includes('Payments and account-changing actions are disabled while impersonating this customer.'),'the persistent impersonation banner must clearly explain the financial/account-change boundary');
assert(impersonationSource.includes("'admin.impersonation.customer_action'")&&impersonationSource.includes("'admin.impersonation.start'")&&impersonationSource.includes("'admin.impersonation.end'"),'impersonation start, denied writes and exit must remain auditable');
const impersonationAppPos=application.indexOf('app.use(createImpersonationAuditRouter())');
for(const marker of ['app.use(createCustomerPasswordSyncRouter())','app.use(createCustomerSubscriptionActionsRouter())','app.use(createFlexibleCheckoutRouter())']){
    const pos=application.indexOf(marker);
    assert(impersonationAppPos>=0&&pos>impersonationAppPos,`impersonation default-deny middleware must run before ${marker}`);
}

const activity=read('src/platform/customer-activity.js');
assert(activity.includes("optionalInsightQuery('summary'")&&activity.includes("optionalInsightQuery('recent-items'"),'personalised Activity analytics must isolate production query failures by analytics slice');
assert(activity.includes('insightData(customerId,rawRange).catch(error=>'),'optional personalised analytics must never make the core Activity page return a 500');
assert(activity.includes('fallbackInsights(rawRange'),'/account/activity must have a complete no-analytics fallback model');
const activityModule=require('../src/platform/customer-activity');
const fallback=activityModule.fallbackInsights('30d');
assert(fallback.degraded===true&&fallback.range.key==='30d','Activity fallback must explicitly mark analytics as degraded while retaining the requested range');
assert(Array.isArray(fallback.heatmap)&&fallback.heatmap.length===7&&Array.isArray(fallback.timeline)&&fallback.timeline.length>=28,'Activity fallback must remain render-safe for the heatmap and daily chart');

console.log('customer dashboard and impersonation read-only boundaries smoke: ok');
require('./customer-workflow-completion-smoke');