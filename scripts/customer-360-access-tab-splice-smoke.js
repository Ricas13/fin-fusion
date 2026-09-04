'use strict';
require('dotenv').config();
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const view=require('../src/platform/customer-360-view');
const accessCards=require('../src/platform/customer-360-access-cards');

const wrapperSource=read('src/platform/customer-360-view.js');
const cardsSource=read('src/platform/customer-360-access-cards.js');
const statusSource=read('src/platform/customer-360-access-status.js');
const holdRouteSource=read('src/platform/admin-customer-access-holds.js');
const v2Source=read('src/platform/customer-360-view-v2.js');
const adminSource=read('src/platform/admin-customer-360.js');
const accessLoaderSource=read('src/platform/customer-360.js');

// Customer 360 is one page now (Customer control grid + Access status +
// per-lane Access/Libraries/Requests panels + Billing + capped Provisioning
// history + Activity), not a set of tabs spliced apart by heading strings.
assert(!/indexOf\(marker\)|const marker=|skipAccessSections/.test(wrapperSource),'Customer 360 must not splice HTML into a legacy Access tab any more');
assert(!/skipAccessSections/.test(v2Source),'the retired tab-splice contract must not linger in v2 either');
assert(v2Source.includes("nav(id,token,appUserId)")||/function nav\(/.test(v2Source),'v2 must expose the single-page nav (Customer record + Portal view)');
assert(wrapperSource.includes("accessCards=require('./customer-360-access-cards')"),'Customer 360 must have one dedicated card renderer');
assert(wrapperSource.includes('async function body(detail,token,options={})'),'the unified page body must no longer take a tab/accessDetail argument');
assert(!wrapperSource.includes('manage.portalSection'),'Portal account/onboarding must remain owned by the canonical Overview/claim workflow rather than being duplicated on the page');
assert(!adminSource.includes('Preview customer portal'),'The redundant Preview customer portal action must be removed');

assert(cardsSource.includes('function controlGrid('),'Customer control must use the compact 3x3 card grid');
assert(cardsSource.includes("option('','Inherit'")&&cardsSource.includes("option('true','Allow'")&&cardsSource.includes("option('false','Deny'"),'Boolean access-control rows must preserve tri-state Inherit / Allow / Deny semantics');
assert(cardsSource.includes('/admin/customer-jellyfin-password?customerId=')&&cardsSource.includes('Change password'),'Jellyfin account details must retain password support inside the Customer control grid');
assert(cardsSource.includes('function laneBlock(')&&cardsSource.includes('accessControlsPanel')&&cardsSource.includes('librariesPanel'),'Access controls and Libraries must render as collapsible dense-row panels per lane, not a giant Access body');
assert(cardsSource.includes('function provisioningHistory(')&&cardsSource.includes('logCapDetails'),'Provisioning history must be capped with an expandable earlier-events disclosure');
assert(cardsSource.includes('function activitySection('),'Activity must remain a dedicated diagnostic section');
assert(cardsSource.indexOf('${provisioningHistory(detail)}')<cardsSource.indexOf('${activitySection(detail)}'),'Activity must be the final Access diagnostic below provisioning history');
assert(!cardsSource.includes('Premium Jellyfin policy')&&!cardsSource.includes('Free Access policy'),'The redesigned page must not duplicate technical controls into the old full-width lane policy tables');

assert(statusSource.includes("type==='payment_risk'")&&statusSource.includes('Review payment incident'),'payment-risk holds must link to the specialized incident workflow rather than expose a generic release button');
assert(statusSource.includes('Type <strong>RELEASE</strong> to confirm')&&statusSource.includes('Why is this hold safe to release?'),'manual hold release must require consequence-aware confirmation and an audit reason');
assert(holdRouteSource.includes("if(type==='payment_risk')throw new Error"),'server-side hold release must refuse payment-risk bypasses even if a crafted form is submitted');
assert(holdRouteSource.includes('FOR UPDATE'),'manual hold release must lock the exact active hold before resolving it');
assert(holdRouteSource.includes('reconcileCustomerForAdmin')&&holdRouteSource.includes("router.post('/admin/users/:customerId/manage/reconcile',reconcileRoute)")&&holdRouteSource.includes("router.post('/admin/users/:customerId/reconcile',reconcileRoute)"),'single-customer reconciliation routes must be thin wrappers over one canonical handler');
assert(accessLoaderSource.includes('provisioning.currentEntitlementTruth(customerId)'),'Customer 360 must load commercial entitlement truth even while access is blocked');
assert(accessLoaderSource.includes('accessHolds.activeHolds(customerId)'),'Customer 360 must load active access holds explicitly');

const manualAssignmentSource=read('src/jellyfin/manual-assignment.js');
assert(!manualAssignmentSource.includes('if(server.full)throw new Error'),'manual administrator assignment must never reject a server because it reached max_users');
assert(manualAssignmentSource.includes("capacityOverride?'admin.customer.server_assign.capacity_override':'admin.customer.server_assign'"),'over-capacity administrator placement must be explicitly audited');
assert(manualAssignmentSource.includes('assignedUsersBefore')&&manualAssignmentSource.includes('assignedUsersAfter')&&manualAssignmentSource.includes('overCapacityAfter'),'manual assignment must record before/after capacity state');
assert(!/UPDATE\s+jellyfin_servers\s+SET\s+max_users/i.test(manualAssignmentSource),'admin assignment must not mutate configured max_users');

function fixture(overrides={}){
  return{
    customer:{id:'cust-1',display_name:'Test Customer',login_username:'testcustomer',login_email:'test@example.invalid',registration_source:'direct'},
    accounts:[],
    activeHolds:[],
    subscriptions:[{status:'active',current_period_end:new Date(Date.now()+86400000),plan_name:'Test Plan',streams:1,service_type:'jellyfin',server_class:'free'}],
    activeStreams:[],
    activitySummary:{last_playback_at:null,watch_seconds_30d:0,sessions_30d:0},
    downloadSummary:{downloads_30d:0},
    playback:[],
    runs:[],
    primaryEntitlement:null,
    provisioningState:null,
    manualPayments:[],
    paymentCustomers:[],
    downloads:[],
    policyEvents:[],
    authSessions:[],
    authEvents:[],
    audit:[],
    requests:[],
    timeline:[],
    ...overrides
  };
}

(async()=>{

// Customer control renders directly from a synthetic operator ctx (the real
// page builds this via admin-customer-operator.js's context(); here we
// exercise the exact same jellyfinAccountCard code path a DB-free test can
// reach) -- including the deliberate over-capacity manual-assignment option
// list that used to live in a separate assignment-prop mechanism.
const overCapacityCtx={
  entitlement:{planName:'Free Server',serverClass:'free',isFreeTier:true,serviceType:'jellyfin'},
  accounts:[],activeAccounts:[],servers:[
    {id:'free-1',name:'Free Server',server_class:'free',operable:true,assigned_users:50,max_users:50,full:true},
    {id:'free-2',name:'Overflow Free',server_class:'free',operable:true,assigned_users:1000,max_users:50,full:true}
  ],adminControl:null,serviceKind:'jellyfin'
};
const overCapacityHtml=accessCards.controlGrid(fixture(),'token',overCapacityCtx,null);
assert(overCapacityHtml.includes('50/50 · FULL')&&overCapacityHtml.includes('1000/50 · OVER +950'),'full and arbitrarily overfilled servers must remain selectable for manual placement');
assert(overCapacityHtml.includes('value="free-1"')&&overCapacityHtml.includes('value="free-2"'),'full and overfull servers must remain actual select options');
assert(overCapacityHtml.includes('Needs access'),'a plan-active customer with no enabled Jellyfin account must show an explicit needs-access state');

const disabledCtx={
  entitlement:{planName:'Free Server',serverClass:'free',isFreeTier:true,serviceType:'jellyfin'},
  accounts:[{disabled:true,jellyfin_username:'testcustomer',server_name:'Free Server'}],activeAccounts:[],servers:[],adminControl:null,serviceKind:'jellyfin'
};
const disabledHtml=accessCards.controlGrid(fixture(),'token',disabledCtx,null);
assert(disabledHtml.includes('Re-enable Jellyfin access'),'a disabled existing account must offer re-enable, not a brand-new assignment');

const failedDetail=fixture({provisioningState:{status:'failed',last_error:'No eligible free server'},subscriptions:[{status:'active',current_period_end:new Date(Date.now()+86400000),plan_name:'Free Server',streams:1,is_free_tier:true,service_type:'jellyfin',server_class:'free'}]});
const failedHtml=await view.body(failedDetail,'token',{});
assert(failedHtml.includes('Access status')&&failedHtml.includes('No active access holds'),'the page must include explicit entitlement/hold diagnostics');
assert(!failedHtml.includes('Portal account & onboarding'),'the page must not duplicate the portal onboarding workflow owned by Overview');
assert(failedHtml.includes('Customer control'),'the page must retain the compact operational control grid');
assert(failedHtml.includes('Needs attention')||failedHtml.includes('Not yet run'),'reconcile status must remain explicit');
const reconcileActions=(failedHtml.match(/\/admin\/users\/cust-1\/manage\/reconcile/g)||[]).length;
assert(reconcileActions>=1,'the page must expose a visible reconcile entry point');
const historyIdx=failedHtml.indexOf('<h2>Provisioning history</h2>');
const activityIdx=failedHtml.indexOf('<h2>Activity</h2>');
assert(historyIdx>=0&&activityIdx>historyIdx,'Activity must sit at the bottom after provisioning history');

const blockedDetail=fixture({
  primaryEntitlement:{subscription_id:'sub-paid',plan_id:'premium',name:'Premium Jellyfin',service_type:'jellyfin',server_class:'premium',blocked:true},
  activeHolds:[
    {id:'hold-admin',hold_type:'admin_suspended',source_key:'admin',reason:'Support suspension under review',created_at:new Date(Date.now()-3600000)},
    {id:'hold-pay',hold_type:'payment_risk',source_key:'stripe:dp_123',reason:'Stripe dispute under review',created_at:new Date(Date.now()-7200000),payment_incident_id:'incident-1'}
  ]
});
const blockedHtml=await view.body(blockedDetail,'token',{});
assert(blockedHtml.includes('2 active access hold'),'a blocked paid customer must still show every access blocker');
assert(blockedHtml.includes('/access-holds/hold-admin/release')&&blockedHtml.includes('Release hold and reconcile'),'known non-payment holds must expose the guarded release workflow');
assert(blockedHtml.includes('/admin/commerce?incident=incident-1#incident-incident-1')&&blockedHtml.includes('Review payment incident'),'payment-risk holds must deep-link to the provider-verifying incident workflow');
assert(!blockedHtml.includes('/access-holds/hold-pay/release'),'payment-risk holds must never render a generic release endpoint');

const activeHtml=view.accessWorkspaceSection(fixture({accounts:[{disabled:false,account_purpose:'jellyfin',server_name:'Free Server',jellyfin_username:'testcustomer'}]}),'token',null);
assert(activeHtml.includes('/admin/customer-jellyfin-password?customerId=cust-1')&&activeHtml.includes('Change password'),'active Jellyfin customers must retain password support inside the Customer control grid');

const stremioHtml=await view.body(fixture({primaryEntitlement:{service_type:'stremio',name:'Stremio Plan',status:'active'}}),'token',{});
assert(stremioHtml.includes('Not required'),'a Stremio-only customer must show the Jellyfin account card as not required rather than prompting for placement');
assert(!stremioHtml.includes('Portal account & onboarding'),'the page must not duplicate portal onboarding for a Stremio-only customer either');
assert(stremioHtml.includes('Test Customer'),'a Stremio-only customer must retain shared Customer 360 chrome');

console.log('customer 360 card access smoke: ok');
})();
