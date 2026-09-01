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

function fixture(overrides = {}) {
    return {
        customer: { id: 'cust-1', display_name: 'Test Customer', login_username: 'testcustomer', login_email: 'test@example.invalid', registration_source: 'direct' },
        accounts: [],
        subscriptions: [{ status: 'active', current_period_end: new Date(Date.now() + 86400000), plan_name: 'Test Plan', streams: 1 }],
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

const failedProvisioningHtml=view.body(fixture({provisioningState:{status:'failed',last_error:'No eligible free server'},subscriptions:[{status:'active',current_period_end:new Date(Date.now()+86400000),plan_name:'Free Server',streams:1,is_free_tier:true}]}),'access','token',null);
assert(failedProvisioningHtml.includes('Provisioning failed / Needs attention.'),'failed Jellyfin provisioning must be explicit on Customer 360');
assert(failedProvisioningHtml.includes('Free Server place remains allocated'),'failed Free Server provisioning must explain that the scarce place remains allocated');
assert(failedProvisioningHtml.includes('Needs attention')&&!failedProvisioningHtml.includes('<div class="summaryValue">0</div><div class="summarySub">0 Jellyfin accounts'),'failed provisioning must not look like a normal zero-account state');

const stremioHtml = view.body(fixture({ primaryEntitlement: { service_type: 'stremio', name: 'Stremio Plan', status: 'active' } }), 'access', 'token', null);
assert(stremioHtml.includes('Stremio access'), 'Stremio-only customer must see the Stremio access panel');
assert(!stremioHtml.includes('<h2>Jellyfin access</h2>'), 'Stremio-only customer must not see the Jellyfin access section');
assert(!stremioHtml.includes('Reconcile / move access'), 'Stremio-only customer must not see Jellyfin reconcile controls');
assert(stremioHtml.includes('Test Customer'), 'Stremio-only customer page must still render the shared hero/summary content');

console.log('customer 360 access-tab splice replacement smoke: ok');
