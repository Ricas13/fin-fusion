'use strict';
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const view = require('../src/platform/customer-360-view');

// The Access tab used to build the full Jellyfin-oriented HTML unconditionally
// and then locate/truncate it via a hardcoded '<h2>Jellyfin access</h2>' string
// search whenever the customer was Stremio-only. Any rewording or restructuring
// of that heading in customer-360-view-v2.js would silently fall through to
// showing the wrong (Jellyfin) section with no test failure. It's now an
// explicit { skipAccessSections } flag threaded through v2.body() instead.
const wrapperSource = read('src/platform/customer-360-view.js');
assert(!/indexOf\(marker\)|const marker=/.test(wrapperSource), 'Customer 360 access tab must not rely on a hardcoded HTML marker search');
assert(wrapperSource.includes('skipAccessSections:true'), 'Stremio-only customers must skip Jellyfin access sections via an explicit flag');
const v2Source = read('src/platform/customer-360-view-v2.js');
assert(v2Source.includes('options.skipAccessSections'), 'customer-360-view-v2.js must expose the skip flag it is given');
assert(/function compactDisclosure/.test(v2Source)&&/<details class=\"section compactDisclosure\">/.test(v2Source),'Customer 360 must use native compact disclosure controls instead of HTML post-processing');
assert(/compactDisclosure\('Access policy'/.test(v2Source),'Access policy must be a compact disclosure');
assert(/compactDisclosure\('Library entitlement'/.test(v2Source),'Library entitlement must be a compact disclosure');
assert(!/<details class=\"section compactDisclosure\" open/.test(v2Source),'Access policy and Library entitlement must be collapsed by default');

const manualAssignmentSource=read('src/jellyfin/manual-assignment.js');
assert(!manualAssignmentSource.includes('if(server.full)throw new Error'), 'manual administrator assignment must never reject a server just because it reached max_users');
assert(manualAssignmentSource.includes("capacityOverride?'admin.customer.server_assign.capacity_override':'admin.customer.server_assign'"),'over-capacity administrator placement must be explicitly audited');
assert(manualAssignmentSource.includes('assignedUsersBefore')&&manualAssignmentSource.includes('assignedUsersAfter')&&manualAssignmentSource.includes('overCapacityAfter'),'manual assignment must record actual before/after capacity state');
assert(!/UPDATE\s+jellyfin_servers\s+SET\s+max_users/i.test(manualAssignmentSource),'admin assignment must not mutate the configured server capacity');
const accessLoaderSource=read('src/platform/customer-360.js');
assert(accessLoaderSource.includes("manualAssignment=require('../jellyfin/manual-assignment')")&&accessLoaderSource.includes('manualAssignment.candidates(customerId)'),'Access detail must load all manual-assignment candidates, including full servers');
assert(wrapperSource.includes('Administrator placement ignores the configured user ceiling.'),'Customer 360 must tell admins that manual placement bypasses the ceiling');
assert(wrapperSource.includes('1000/50'),'Customer 360 must make arbitrary over-capacity admin placement semantics explicit');
assert(wrapperSource.includes('accessWorkspaceSection(safe,token,accessDetail)+html'),'primary Access controls must render before large policy/provisioning diagnostics');

function fixture(overrides = {}) {
    return {
        customer: { id: 'cust-1', display_name: 'Test Customer', login_username: 'testcustomer', login_email: 'test@example.invalid', registration_source: 'direct' },
        accounts: [],
        subscriptions: [{ status: 'active', current_period_end: new Date(Date.now() + 86400000), plan_name: 'Test Plan', streams: 1, service_type: 'jellyfin', server_class: 'free' }],
        activeStreams: [],
        activitySummary: { last_playback_at: null, watch_seconds_30d: 0, sessions_30d: 0 },
        downloadSummary: { downloads_30d: 0 },
        runs: [],
        primaryEntitlement: null,
        provisioningState: null,
        ...overrides
    };
}

const jellyfinHtml = view.body(fixture(), 'access', 'token', null);
assert(jellyfinHtml.includes('Jellyfin access'), 'Jellyfin customer must still see the Jellyfin access section');
assert(!jellyfinHtml.includes('Stremio access'), 'Jellyfin customer must not see the Stremio access panel');

const failedDetail=fixture({provisioningState:{status:'failed',last_error:'No eligible free server'},subscriptions:[{status:'active',current_period_end:new Date(Date.now()+86400000),plan_name:'Free Server',streams:1,is_free_tier:true,service_type:'jellyfin',server_class:'free'}]});
const assignment={entitlement:{id:'free-plan'},activeAccounts:[],servers:[
  {id:'free-1',name:'Free Server',health_status:'healthy',assigned_users:50,max_users:50,full:true},
  {id:'free-2',name:'Overflow Free',health_status:'healthy',assigned_users:1000,max_users:50,full:true}
]};
const failedProvisioningHtml=view.body(failedDetail,'access','token',{currentPlan:failedDetail.subscriptions[0],effective:null,assignment});
assert(failedProvisioningHtml.includes('Provisioning failed / Needs attention.'),'failed Jellyfin provisioning must be explicit on Customer 360');
assert(failedProvisioningHtml.includes('Free Server place remains allocated'),'failed Free Server provisioning must explain that the scarce place remains allocated');
assert(failedProvisioningHtml.includes('Needs attention')&&!failedProvisioningHtml.includes('<div class="summaryValue">0</div><div class="summarySub">0 Jellyfin accounts'),'failed provisioning must not look like a normal zero-account state');
assert(failedProvisioningHtml.includes('Assign Jellyfin server'),'fresh failed provisioning must expose direct manual server assignment');
assert(failedProvisioningHtml.includes('50/50 · FULL')&&failedProvisioningHtml.includes('1000/50 · OVER +950'),'full and arbitrarily overfilled servers must remain selectable by an administrator');
assert(failedProvisioningHtml.includes('does not create public Free Server availability'),'manual override UI must state that public availability is not reopened');
assert(failedProvisioningHtml.indexOf('Access assignment & customer overrides')<failedProvisioningHtml.indexOf('Jellyfin access'),'administrator repair controls must be above Jellyfin policy/provisioning detail');

const stremioHtml = view.body(fixture({ primaryEntitlement: { service_type: 'stremio', name: 'Stremio Plan', status: 'active' } }), 'access', 'token', null);
assert(stremioHtml.includes('Stremio access'), 'Stremio-only customer must see the Stremio access panel');
assert(!stremioHtml.includes('<h2>Jellyfin access</h2>'), 'Stremio-only customer must not see the Jellyfin access section');
assert(!stremioHtml.includes('Reconcile / move access'), 'Stremio-only customer must not see Jellyfin reconcile controls');
assert(stremioHtml.includes('Test Customer'), 'Stremio-only customer page must still render the shared hero/summary content');

console.log('customer 360 access-tab splice replacement smoke: ok');
