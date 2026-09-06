'use strict';

const assert=require('assert');
const fs=require('fs');

const read=path=>fs.readFileSync(path,'utf8');
const termination=read('src/payments/subscription-termination.js');
const targeted=read('src/platform/admin-subscription-revoke.js');
const composition=read('src/platform/admin-route-composition.js');
const html=read('src/platform/admin-html-core.js');
const customerView=read('src/platform/customer-360-view.js');

assert(targeted.includes("r.get('/admin/users/:customerId/subscriptions/revoke',page)"),'admin must expose a plan picker for targeted revocation');
assert(targeted.includes("r.post('/admin/users/:customerId/subscriptions/:subscriptionId/revoke'"),'admin must expose a subscription-bound revoke mutation');
assert(targeted.includes('s.id=$1 AND s.customer_id=$2'),'targeted revoke must re-authorize the selected subscription against the customer');
assert(targeted.includes("String(req.body.confirmWord||'').trim()!=='REVOKE'"),'targeted revoke must require typed REVOKE confirmation');
assert(targeted.includes("billingControl.terminateRecurringForDeletion(row"),'non-Jellyfin recurring selections must cancel and verify their own provider agreement');
assert(targeted.includes('subscriptionTermination.terminateRecurringNow(row'),'Jellyfin/bundle primary selections must retain the durable provider termination workflow');
assert(targeted.includes("if(['stremio','bundle'].includes(type))stremioCleanup=await cleanupStremio"),'selected Stremio/bundle revocation must clean up live Stremio access');
assert(targeted.includes('const remaining=await stremio.entitledSubscription(customerId)'),'Stremio cleanup must preserve access when another valid Stremio entitlement remains');
assert(targeted.includes('await stremio.revoke(customerId)'),'last Stremio entitlement must hard-revoke its installation credential');
assert(targeted.includes('await managedStremio.revokeInactiveMappings()'),'last Stremio entitlement must revoke managed media-server mappings too');
assert(targeted.includes("'admin.subscription.revoke_selected.completed'"),'targeted plan revocation must be auditable');
assert(targeted.includes('Other plans were preserved.'),'operator feedback must state that unrelated plans were preserved');

assert(customerView.includes('function addPlanRevokeAction'),'Customer 360 must add the per-plan revoke entry while rendering on the server');
assert(customerView.includes('function removeLegacyPlanRevoke'),'Customer 360 must remove the legacy Jellyfin-only revoke form while rendering on the server');
assert(customerView.includes('liveSubscriptions(detail).length'),'server-rendered revoke entry must be available for any customer with a live plan, including Stremio-only customers');
assert(customerView.includes('Revoke a plan…'),'Customer 360 must present an unambiguous plan-specific revoke action');
assert(customerView.includes('/subscriptions/revoke'),'Customer 360 revoke action must open the plan picker');
assert(customerView.includes('value=\\"end_jellyfin_plan\\"')||customerView.includes('value="end_jellyfin_plan"'),'server renderer must explicitly identify the legacy Jellyfin-only revoke action for removal');
assert(!html.includes('/js/admin-per-plan-revoke.js'),'plan revocation safety must not depend on a client-side rewrite shim');
assert(!fs.existsSync('public/js/admin-per-plan-revoke.js'),'obsolete client-side plan revoke shim must be removed');
assert(composition.includes("require('./admin-subscription-revoke')"),'targeted revoke router must be composed into admin routes');
assert(composition.indexOf('createAdminSubscriptionRevokeRouter()')<composition.indexOf("mountCritical('customer360'"),'targeted routes must mount before the Customer 360 wildcard');

assert(termination.includes('async function hardRevokeRefundedStremio'),'confirmed refunds must have a dedicated hard Stremio cleanup path');
assert(termination.includes("['stremio','bundle'].includes(String(result.serviceType||''))"),'refund hard cleanup must be scoped to Stremio-bearing purchases');
assert(termination.includes('const remaining=await stremio.entitledSubscription(customerId)'),'refund cleanup must not revoke a different valid Stremio subscription');
assert(termination.includes('await stremio.revoke(customerId)'),'a fully refunded last Stremio plan must invalidate the install credential');
assert(termination.includes('await managed.revokeInactiveMappings()'),'a fully refunded last Stremio plan must retire managed Stremio mappings');
assert(termination.includes("reason:'already_terminated',id:subscription.id,customerId,serviceType:effectiveServiceType"),'duplicate refund delivery must retain enough service identity to retry Stremio cleanup');
assert(termination.includes('return hardRevokeRefundedStremio(customerId,local)'),'refund termination must always pass through hard cleanup after local convergence');

console.log('per-plan revoke + Stremio refund smoke: ok');
