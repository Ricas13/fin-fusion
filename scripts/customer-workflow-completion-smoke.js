'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const ejs=require('ejs');
const adminNav=require('../src/platform/admin-nav');
const customer360View=require('../src/platform/customer-360-view');
const {restrictedImpersonationAction,injectBanner}=require('../src/platform/admin-impersonation');

const root=path.join(__dirname,'..');
const dashboardPath=path.join(root,'views/customer/dashboard.ejs');
const dashboardTemplate=fs.readFileSync(dashboardPath,'utf8');
const customer360Source=fs.readFileSync(path.join(root,'src/platform/admin-customer-360.js'),'utf8');
const customerManagementSource=fs.readFileSync(path.join(root,'src/platform/admin-customer-management.js'),'utf8');

function subscription(cancelAtPeriodEnd=false){
  return{
    id:'sub-current',subscription_id:'sub-current',plan_id:'plan-current',status:'active',source:'paypal',
    provider_subscription_id:'I-SMOKE-PAYPAL',cancel_at_period_end:cancelAtPeriodEnd,
    current_period_end:'2099-09-30T12:00:00.000Z',service_type:'jellyfin',service_type_snapshot:'jellyfin',
    plan_name:'Current PayPal',plan_code:'current-paypal',billing_interval:'month',billing_interval_snapshot:'month',
    duration_days:30,duration_days_snapshot:30,streams:3,is_free_tier:false
  };
}
function plan(id,code,name,priceMinor){
  return{id,code,name,description:'Smoke plan',audience:'direct',service_type:'jellyfin',billing_interval:'month',duration_days:30,price_minor:priceMinor,currency:'GBP',streams:3,allow_downloads:true,payment_options:[{provider:'paypal'}]};
}
function renderDashboard(cancelAtPeriodEnd=false,openPlanChange={state:'pending',target_plan_name:'Next PayPal',target_plan_code:'next-paypal',effective_at:'2099-09-30T12:00:00.000Z'}){
  const recurring=subscription(cancelAtPeriodEnd);
  const current=plan('plan-current','current-paypal','Current PayPal',600);
  const next=plan('plan-next','next-paypal','Next PayPal',900);
  return ejs.render(dashboardTemplate,{
    siteName:'CAPTAiNFiN',
    portal:{customer:{login_username:'workflow-smoke'},subscriptions:[recurring],accounts:[],providers:[{provider:'paypal'}],referralsEnabled:false,referralCode:null},
    plans:[current,next],
    currentPlan:{...recurring,subscription_id:'sub-current',plan_id:'plan-current'},
    freePlan:null,stremioPlan:null,renewalSubscription:recurring,openPlanChange,
    stripeEnabled:false,paypalEnabled:true,plisioEnabled:false,currency:'GBP',navOptions:{},overseerrUrl:null,
    requestAccess:null,requestSyncConfigured:false,libraryProfiles:[],provisioningState:null,csrfToken:'csrf-smoke',
    message:null,error:null,welcome:false,hasJellyfin:true,hasStremio:false,stremioHousehold:null,
    stremioInstallUrl:null,stremioManifestUrl:null
  },{filename:dashboardPath});
}

const renewalOn=renderDashboard(false);
assert(renewalOn.includes('action="/account/subscription/renewal"'),'account home must render the existing renewal mutation form');
assert(renewalOn.includes('name="action" value="stop"')&&renewalOn.includes('Stop automatic renewal'),'active automatic renewal must expose a Stop action');
assert(renewalOn.includes('href="#renewal-control"')&&renewalOn.includes('Stop PayPal renewal first'),'blocked PayPal plan cards must point to the real renewal control');
assert(!renewalOn.includes('aria-disabled="true">Stop PayPal renewal first'),'PayPal plan-change guidance must not remain a dead disabled control');
assert(renewalOn.includes('action="/account/plan-change/cancel"'),'open plan changes must expose the existing cancellation mutation on account home');
assert(renewalOn.includes('Next PayPal')&&renewalOn.includes('Scheduled')&&renewalOn.includes('Cancel plan change'),'open plan-change target, state and cancellation must render together');

const renewalStopped=renderDashboard(true,null);
assert(renewalStopped.includes('name="action" value="resume"')&&renewalStopped.includes('Resume automatic renewal'),'stopped automatic renewal must expose Resume on the current plan');
assert(renewalStopped.includes('action="/account/checkout/paypal"')&&renewalStopped.includes('Continue with PayPal'),'after PayPal renewal is stopped another PayPal plan must be actionable from the same page');

const loginPath=path.join(root,'views/customer/login.ejs');
const login=ejs.render(fs.readFileSync(loginPath,'utf8'),{siteName:'CAPTAiNFiN',turnstileEnabled:false,message:null,error:null,csrfToken:'csrf',next:'/account'},{filename:loginPath});
assert(login.includes('claim link')&&login.includes('instead of registering again'),'login must direct imported Jellyfin customers back to their emailed claim link');
const registerPath=path.join(root,'views/customer/register.ejs');
const register=ejs.render(fs.readFileSync(registerPath,'utf8'),{siteName:'CAPTAiNFiN',turnstileEnabled:false,freeIntent:false,registrationOpen:true,verificationRequired:false,freeHoldMinutes:20,error:null,csrfToken:'csrf',referralsEnabled:false,referralCode:''},{filename:registerPath});
assert(register.includes('claim link')&&register.includes('do not register again'),'registration must warn imported Jellyfin customers not to create a duplicate portal account');

assert(!adminNav.groups.some(group=>group.key==='resellers'),'reserved reseller routes must not appear as a shipped module in the default admin sidebar');
const bulkCustomersSource=fs.readFileSync(path.join(root,'src/platform/admin-bulk-customers.js'),'utf8');
const bulkOperationsSource=fs.readFileSync(path.join(root,'src/platform/bulk-operations.js'),'utf8');
const requestUsersSource=fs.readFileSync(path.join(root,'src/platform/admin-request-users.js'),'utf8');
assert(bulkCustomersSource.includes("['plan_change','Manual entitlement edit',"),'the plan_change bulk-action catalog must label itself as a manual entitlement edit at the source, not via a rendering-time patch');
assert(!bulkCustomersSource.includes("'Change plan'"),'no bulk-action catalog entry should still say "Change plan"');
assert(customer360Source.includes("bulkActionForm(token,c.id,'plan_change','Manual entitlement edit')"),'Customer 360 must label plan_change as a manual entitlement edit at the source door');
assert(!requestUsersSource.includes('Change plan'),'the request-users bulk plan-change button must not still say "Change plan"');
assert(requestUsersSource.includes('Manual entitlement edit'),'the request-users bulk plan-change button must say "Manual entitlement edit"');
assert(!fs.readFileSync(path.join(root,'src/platform/admin-html-core.js'),'utf8').includes('clarifyManualEntitlementLabels'),'the label-rewriting patch should be removed once every source site labels itself correctly');
const manualHandler=bulkOperationsSource.slice(bulkOperationsSource.indexOf("registerHandler('plan_change'"),bulkOperationsSource.indexOf("registerHandler('extend_entitlement'"));
assert(manualHandler.includes('applyManualEntitlementContract(sub,target)'),'recurring provider customers must use the local manual entitlement contract');
assert(!manualHandler.includes('requestChange('),'Manual entitlement edit must never call customer-plan-change.requestChange or schedule a provider change');
assert(manualHandler.includes('providerBillingChanged:false')&&manualHandler.includes("mode:'manual_entitlement'"),'manual entitlement edits must explicitly preserve provider billing state');
assert(bulkOperationsSource.includes('billingContractPreserved:true'),'the recurring manual entitlement snapshot must preserve the existing provider billing contract while replacing access terms');
assert(customerManagementSource.includes('function accessPath(')&&customerManagementSource.includes('return res.redirect(accessPath(id,key,message,anchor))'),'folded /manage POST actions must return success/error feedback directly to the Access tab');
assert(customerManagementSource.includes("r.get('/admin/users/:customerId/manage'")&&customerManagementSource.includes('return res.redirect(accessPath(req.params.customerId,key,message))'),'GET /manage must redirect into Access and preserve an existing message/error');

const localAccessHtml=customer360View.accessWorkspaceSection({customer:{id:'00000000-0000-4000-8000-000000000001'},subscriptions:[{...subscription(false),source:'manual',provider_subscription_id:null}],accounts:[{disabled:false,account_purpose:'jellyfin',server_name:'Server A',recon_status:'successful'}]},'csrf',{currentPlan:{...plan('plan-current','current-paypal','Current PayPal',600),server_class:'premium',current_period_end:'2099-09-30T12:00:00.000Z'}});
for(const label of ['Manual entitlement edit','Reset all to plan','Move server','Use plan placement','Change expiry','Reset expiry to plan term','Reconcile access'])assert(localAccessHtml.includes(label),`Access must expose ${label} without leaving the customer workspace`);
assert(localAccessHtml.includes('/server-placement/reset')&&localAccessHtml.includes('name="confirmation"')&&localAccessHtml.includes('placeholder="PLACE"'),'automatic plan placement reset must be an explicit typed-confirmation customer action');
assert(localAccessHtml.includes('/expiry/reset'),'locally controlled expiry must have a direct reset-to-plan action');
assert(customer360Source.includes("/admin/users/:customerId/server-placement/reset'")&&customer360Source.includes('provisioning.selectServerForPlan(entitlement)')&&customer360Source.includes('serverMigration.createMigration')&&customer360Source.includes('serverMigration.executeMigration'),'server reset must use canonical plan placement plus the guarded migration service when a move is required');
assert(customer360Source.includes("String(req.body.confirmation||'').trim().toUpperCase()!=='PLACE'"),'automatic placement must require typed PLACE confirmation before a possible server move');
assert(customer360Source.includes("/admin/users/:customerId/expiry/reset'")&&customer360Source.includes('planExpiry.endForPlan(entitlement)'),'expiry reset must compute the current plan term through the canonical plan-expiry owner');
assert(customer360Source.includes('if(recurringProviderSubscription(sub))throw new Error'),'expiry reset must refuse provider-controlled recurring billing periods');

const recurringAccessHtml=customer360View.accessWorkspaceSection({customer:{id:'00000000-0000-4000-8000-000000000001'},subscriptions:[subscription(false)],accounts:[]},'csrf',{currentPlan:{...plan('plan-current','current-paypal','Current PayPal',600),server_class:'premium',current_period_end:'2099-09-30T12:00:00.000Z'}});
assert(recurringAccessHtml.includes('Manage renewal in Billing')&&!recurringAccessHtml.includes('Change expiry')&&!recurringAccessHtml.includes('Reset expiry to plan term'),'provider-controlled recurring expiry must stay a Billing fact/action rather than pretending a local expiry mutation is provider-safe');

const impersonatedPost=route=>({session:{impersonation:{id:'workflow-smoke'}},method:'POST',path:route});
for(const route of ['/account/subscription/renewal','/account/checkout/paypal','/account/plan-change/cancel']){
  assert.strictEqual(restrictedImpersonationAction(impersonatedPost(route)),'customer changes',`read-only support view must block ${route}`);
}
const bannerHtml=injectBanner('<html><body><main>customer</main></body></html>',{session:{impersonation:{id:'workflow-smoke',displayName:'Smoke Customer'},csrfToken:'csrf-smoke'}});
assert(bannerHtml.includes('Read-only support view: Smoke Customer'),'impersonation banner must identify the read-only support boundary');
assert(bannerHtml.includes('all customer account changes are blocked while impersonating'),'impersonation banner must explain that support cannot mutate the customer account');

console.log('customer/admin workflow completion smoke: ok');
