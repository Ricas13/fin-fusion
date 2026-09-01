'use strict';
require('dotenv').config();
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const view=require('../src/platform/customer-360-view');

const wrapperSource=read('src/platform/customer-360-view.js');
const cardsSource=read('src/platform/customer-360-access-cards.js');
const v2Source=read('src/platform/customer-360-view-v2.js');
const adminSource=read('src/platform/admin-customer-360.js');

assert(!/indexOf\(marker\)|const marker=/.test(wrapperSource),'Customer 360 must not splice Access HTML using heading strings');
assert(wrapperSource.includes('skipAccessSections:true'),'Access must render shared Customer 360 chrome without the legacy giant Access body');
assert(v2Source.includes('options.skipAccessSections'),'v2 must keep the explicit Access skip contract');
assert(wrapperSource.includes("accessCards=require('./customer-360-access-cards')"),'Customer 360 must have one dedicated card Access renderer');
assert(!wrapperSource.includes('manage.portalSection'),'Portal account/onboarding must not be duplicated on the Access tab');
assert(!adminSource.includes('Preview customer portal'),'The redundant Preview customer portal action must be removed');

assert(cardsSource.includes('accessOverviewGrid'),'Access summary must use compact overview cards');
assert(cardsSource.includes('accessControlGrid'),'Technical access controls must use a responsive card grid');
assert(cardsSource.includes("grid-template-columns:repeat(3,minmax(0,1fr))"),'Desktop technical controls must use a 3-column grid');
assert(cardsSource.includes("option('','Inherit'")&&cardsSource.includes("option('true','Allow'")&&cardsSource.includes("option('false','Deny'"),'Boolean access cards must preserve tri-state Inherit / Allow / Deny semantics');
assert(cardsSource.includes('Save access changes'),'Technical cards must save together');
assert(/<details class=\"section accessDisclosure\"><summary class=\"accessDisclosureSummary\"><div><span class=\"accessEyebrow\">Libraries/.test(cardsSource),'Libraries must be collapsed behind a compact summary');
assert(cardsSource.includes('Provisioning history')&&cardsSource.includes('accessHistory'),'Provisioning history must be a collapsed lower disclosure');
assert(cardsSource.includes('accessActivity'),'Activity must be a collapsed lower disclosure');
assert(cardsSource.indexOf('${provisioningHistory(detail)}')<cardsSource.indexOf('${activitySection(detail)}'),'Activity must be the final Access diagnostic below provisioning history');
assert(!cardsSource.includes('Premium Jellyfin policy')&&!cardsSource.includes('Free Access policy'),'The redesigned Access tab must not duplicate technical controls into lane policy tables');

const manualAssignmentSource=read('src/jellyfin/manual-assignment.js');
assert(!manualAssignmentSource.includes('if(server.full)throw new Error'),'manual administrator assignment must never reject a server because it reached max_users');
assert(manualAssignmentSource.includes("capacityOverride?'admin.customer.server_assign.capacity_override':'admin.customer.server_assign'"),'over-capacity administrator placement must be explicitly audited');
assert(manualAssignmentSource.includes('assignedUsersBefore')&&manualAssignmentSource.includes('assignedUsersAfter')&&manualAssignmentSource.includes('overCapacityAfter'),'manual assignment must record before/after capacity state');
assert(!/UPDATE\s+jellyfin_servers\s+SET\s+max_users/i.test(manualAssignmentSource),'admin assignment must not mutate configured max_users');
const accessLoaderSource=read('src/platform/customer-360.js');
assert(accessLoaderSource.includes("manualAssignment=require('../jellyfin/manual-assignment')")&&accessLoaderSource.includes('manualAssignment.candidates(customerId)'),'Access detail must load full/overfull manual-assignment candidates');

function fixture(overrides={}){
  return{
    customer:{id:'cust-1',display_name:'Test Customer',login_username:'testcustomer',login_email:'test@example.invalid',registration_source:'direct'},
    accounts:[],
    subscriptions:[{status:'active',current_period_end:new Date(Date.now()+86400000),plan_name:'Test Plan',streams:1,service_type:'jellyfin',server_class:'free'}],
    activeStreams:[],
    activitySummary:{last_playback_at:null,watch_seconds_30d:0,sessions_30d:0},
    downloadSummary:{downloads_30d:0},
    playback:[],
    runs:[],
    primaryEntitlement:null,
    provisioningState:null,
    ...overrides
  };
}
function effectiveFixture(){
  const technicalRows={};
  for(const field of ['streams','allow_downloads','allow_video_transcoding','allow_audio_transcoding','allow_remuxing','allow_live_tv','allow_live_tv_management','allow_remote_access','allow_subtitle_editing'])technicalRows[field]={plan:field==='streams'?1:false,override:null,effective:field==='streams'?1:false};
  return{technicalRows,visibleNames:['Movies'],entitlementRows:[{name:'Movies',plan:true,override:null,effective:true},{name:'TV',plan:true,override:false,effective:false}],catalog:{failedServers:[]}};
}

const assignment={entitlement:{id:'free-plan'},activeAccounts:[],servers:[
  {id:'free-1',name:'Free Server',health_status:'healthy',assigned_users:50,max_users:50,full:true},
  {id:'free-2',name:'Overflow Free',health_status:'healthy',assigned_users:1000,max_users:50,full:true}
]};
const plan={id:'free-plan',plan_name:'Free Server',name:'Free Server',is_free_tier:true,service_type:'jellyfin',server_class:'free'};
const failedDetail=fixture({provisioningState:{status:'failed',last_error:'No eligible free server'},subscriptions:[{status:'active',current_period_end:new Date(Date.now()+86400000),plan_name:'Free Server',streams:1,is_free_tier:true,service_type:'jellyfin',server_class:'free'}]});
const failedHtml=view.body(failedDetail,'access','token',{currentPlan:plan,effective:effectiveFixture(),assignment},{householdOverrides:{}});
assert(failedHtml.includes('Access overview'),'Access must begin with the compact operational overview');
assert(failedHtml.includes('Provisioning failed / Needs attention.'),'failed provisioning must remain explicit');
assert(failedHtml.includes('Free Server entitlement remains allocated'),'failed Free Server provisioning must explain that entitlement remains allocated during repair');
assert(failedHtml.includes('Assign Jellyfin server'),'fresh failed provisioning must expose direct manual assignment');
assert(failedHtml.includes('50/50 · FULL')&&failedHtml.includes('1000/50 · OVER +950'),'full and arbitrarily overfilled servers must remain selectable');
assert(failedHtml.includes('does not')===false||failedHtml.includes('without changing the limit'),'manual assignment explanation must preserve configured public capacity');
assert(failedHtml.includes('accessControlGrid')&&failedHtml.includes('Concurrent streams')&&failedHtml.includes('Subtitle editing'),'all nine technical access controls must render as cards');
assert(failedHtml.includes('Inherit')&&failedHtml.includes('Allow')&&failedHtml.includes('Deny'),'rendered controls must expose tri-state choices');
assert(failedHtml.includes('Manage libraries')&&!failedHtml.includes('<h2>Free Access policy</h2>'),'libraries must be compact and duplicate Free Access policy tables must be absent');
assert(!failedHtml.includes('Portal account & onboarding'),'Access must not contain portal onboarding controls');
assert(failedHtml.indexOf('Provisioning history')<failedHtml.indexOf('Activity'),'Activity must sit at the bottom after provisioning history');
assert(!/<details class="section accessDisclosure"[^>]* open/.test(failedHtml),'Access disclosures must be collapsed by default');

const manualHtml=view.manualServerAssignmentForm('token','cust-1',assignment);
assert(manualHtml.includes('50/50 · FULL')&&manualHtml.includes('1000/50 · OVER +950'),'manual assignment helper must preserve over-capacity options');
assert(manualHtml.includes('name="serverId"')&&manualHtml.includes('value="free-1"')&&manualHtml.includes('value="free-2"'),'full and overfull servers must remain actual select options');

const stremioHtml=view.body(fixture({primaryEntitlement:{service_type:'stremio',name:'Stremio Plan',status:'active'}}),'access','token',null,{});
assert(stremioHtml.includes('Stremio access'),'Stremio-only customer must retain Stremio access controls');
assert(!stremioHtml.includes('accessControlGrid'),'Stremio-only customer must not see Jellyfin technical cards');
assert(!stremioHtml.includes('Portal account & onboarding'),'Stremio Access must not duplicate portal onboarding either');
assert(stremioHtml.includes('Test Customer'),'Stremio Access must retain shared Customer 360 chrome');

console.log('customer 360 card access smoke: ok');
