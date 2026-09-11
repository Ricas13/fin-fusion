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
const firstMutationStart=cleanup.indexOf('async function declineDeletedFreeAccess');
const restoreMutationStart=cleanup.indexOf('async function restoreReturningCustomer');
assert(inspectStart>=0&&firstMutationStart>inspectStart&&restoreMutationStart>firstMutationStart,'cleanup-return service must separate read-only inspection from explicit decline/restore mutations');
const inspectBlock=cleanup.slice(inspectStart,firstMutationStart);
assert(!inspectBlock.includes('releaseHold('),'read-only restoration inspection must not release access holds');
assert(!inspectBlock.includes('UPDATE jellyfin_account_lifecycle'),'read-only restoration inspection must not mutate lifecycle history');
assert(!inspectBlock.includes('INSERT INTO audit_log'),'read-only restoration inspection must not append mutation audit events');
assert(cleanup.slice(restoreMutationStart).includes('await returningCustomerStatus(customerId)'),'restoration mutation must re-check eligibility instead of trusting stale GET state');

// Admin impersonation is an owner-only "act on behalf of" mode. Ordinary
// account/service changes are allowed, while anything that can create or
// increase a customer charge is denied centrally before billing routers run.
const impersonationSource=read('src/platform/admin-impersonation.js');
const credentialSource=read('src/security/admin-impersonation-credentials.js');
const ownerGuardSource=read('src/auth/owner-guard.js');
const application=read('src/application.js');
const {restrictedImpersonationAction,wantsJson}=require('../src/platform/admin-impersonation');
const impersonationCredentials=require('../src/security/admin-impersonation-credentials');
assert(impersonationSource.includes("const { requireOwner, ownerStatus } = require('../auth/owner-guard');"),'impersonation must use the canonical owner capability service');
assert(impersonationSource.includes("router.post('/admin/users/:customerId/impersonate', gate, requireOwner"),'support administrators must not be able to start customer impersonation');
assert(impersonationSource.includes('if (!await ownerStatus(req.session.authUserId)) return next();'),'Customer 360 must hide the impersonation action from support-only administrators');
assert(ownerGuardSource.includes('COALESCE(is_owner,FALSE) AS is_owner')&&ownerGuardSource.includes("user.role === 'admin' && user.active && user.is_owner"),'owner authorization must be database-backed, active, and fail closed');
assert(/row\?\.role === 'customer'/.test(impersonationSource),'privileged/admin identities must never be impersonation targets');

const impersonated=(method,pathname,body={})=>({session:{impersonation:{id:'test'}},method,path:pathname,body});
const allowedMutations=[
    '/account/access/media/00000000-0000-4000-8000-000000000001/username',
    '/account/jellyfin/00000000-0000-4000-8000-000000000001/password',
    '/account/requests/password',
    '/account/security/password',
    '/account/stremio/install',
    '/account/stremio/reset-household',
    '/account/stremio/revoke',
    '/account/provisioning/retry',
    '/account/profile',
    '/account/plan-change/cancel'
];
for(const pathname of allowedMutations){
    assert.strictEqual(restrictedImpersonationAction(impersonated('POST',pathname)),null,`impersonation must allow non-spending account action ${pathname}`);
}
for(const method of ['PUT','PATCH','DELETE'])assert.strictEqual(restrictedImpersonationAction(impersonated(method,'/account/profile')),null,`${method} non-spending account changes must remain available while impersonating`);
for(const pathname of ['/account/checkout/stripe','/account/checkout/paypal','/account/checkout/plisio','/account/billing/payment-method','/account/purchase/plan','/account/upgrade/plan','/account/add-ons/stremio']){
    assert.strictEqual(restrictedImpersonationAction(impersonated('POST',pathname)),'spending',`impersonation must block spending action ${pathname}`);
}
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/subscription/renewal',{action:'stop'})),null,'stopping automatic renewal must remain available while impersonating');
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/subscription/renewal',{action:'resume'})),'spending','resuming automatic renewal must be blocked because it creates future spend');
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/checkout/cancel-open')),null,'cancelling an unfinished checkout must remain available');
for(const method of ['GET','HEAD','OPTIONS'])assert.strictEqual(restrictedImpersonationAction(impersonated(method,'/account')),null,`${method} browsing must remain available while impersonating`);
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/impersonation/exit')),null,'audited impersonation exit must remain available');
assert.strictEqual(restrictedImpersonationAction({session:{},method:'POST',path:'/account/checkout/stripe'}),null,'normal customer sessions must not be affected by impersonation policy');
assert.strictEqual(wantsJson({headers:{accept:'application/json'}}),true,'API-style impersonation denials must support structured JSON responses');
assert.strictEqual(wantsJson({headers:{accept:'text/html'}}),false,'normal browser denials must remain HTML/text responses');
assert(impersonationSource.includes("error:'impersonation_spending_disabled'")&&impersonationSource.includes('Spending actions are disabled while impersonating.'),'blocked spending actions must return a stable no-spend error contract');
assert(impersonationSource.includes('Admin editing as customer:')&&impersonationSource.includes('could create or increase a charge'),'the persistent impersonation banner must explain that account editing is enabled but spending is not');
assert(impersonationSource.includes("'admin.impersonation.customer_action'")&&impersonationSource.includes("'admin.impersonation.start'")&&impersonationSource.includes("'admin.impersonation.end'"),'impersonation start, customer mutations and exit must remain auditable');
assert(impersonationSource.includes('blockedByImpersonation:Boolean(restriction)'),'impersonation mutation audit must distinguish blocked spending from successful on-behalf-of changes');
assert(impersonationSource.includes("router.use('/account/security/password'")&&impersonationSource.includes('impersonationCredentials.setPortalPassword'),'owner impersonation must intercept the portal-password form without registering a competing customer POST route');
assert(credentialSource.includes('customers.validateNewPassword(newPassword)')&&credentialSource.includes('session_version=session_version+1'),'admin-set portal passwords must retain the normal password policy and rotate customer session version');
assert(credentialSource.includes("role='customer' AND revoked_at IS NULL")&&credentialSource.includes('DELETE FROM user_sessions'),'admin-set portal passwords must revoke existing customer sessions');
assert(credentialSource.includes("'admin.impersonation.portal_password_set'")&&credentialSource.includes('oldPasswordRead:false'),'portal-password reset must audit the real admin action without reading the old password');
const samplePasswordForm='<form method="post" action="/account/security/password"><input type="hidden" name="_csrf" value="x"><div class="field"><label>Current password</label><input class="input" type="password" name="currentPassword" required></div><div class="field"><label>New password</label></div><button>Change password &amp; sign out other sessions</button></form>';
const rewrittenPasswordForm=impersonationCredentials.rewriteSecurityPage(samplePasswordForm);
assert(!rewrittenPasswordForm.includes('name="currentPassword"')&&rewrittenPasswordForm.includes('Admin impersonation: set a new portal password'),'impersonated Account Security must not ask the owner for the customer current password');
assert(rewrittenPasswordForm.includes('Set portal password &amp; sign out customer sessions'),'impersonated Account Security must label the action as an administrative password set');
const impersonationAppPos=application.indexOf('app.use(createImpersonationAuditRouter())');
for(const marker of ['app.use(createCustomerPasswordSyncRouter())','app.use(createCustomerSubscriptionActionsRouter())','app.use(createFlexibleCheckoutRouter())']){
    const pos=application.indexOf(marker);
    assert(impersonationAppPos>=0&&pos>impersonationAppPos,`impersonation spending guard must run before ${marker}`);
}

const activity=read('src/platform/customer-activity.js');
assert(activity.includes("optionalInsightQuery('summary'")&&activity.includes("optionalInsightQuery('recent-items'"),'personalised Activity analytics must isolate production query failures by analytics slice');
assert(activity.includes('insightData(customerId,rawRange).catch(error=>'),'optional personalised analytics must never make the core Activity page return a 500');
assert(activity.includes('fallbackInsights(rawRange'),'/account/activity must have a complete no-analytics fallback model');
const activityModule=require('../src/platform/customer-activity');
const fallback=activityModule.fallbackInsights('30d');
assert(fallback.degraded===true&&fallback.range.key==='30d','Activity fallback must explicitly mark analytics as degraded while retaining the requested range');
assert(Array.isArray(fallback.heatmap)&&fallback.heatmap.length===7&&Array.isArray(fallback.timeline)&&fallback.timeline.length>=28,'Activity fallback must remain render-safe for the heatmap and daily chart');

console.log('customer dashboard and impersonation no-spend boundaries smoke: ok');
require('./customer-workflow-completion-smoke');
