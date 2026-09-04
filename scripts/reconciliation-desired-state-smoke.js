'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const desiredState = require('../src/entitlements/customer-access-desired-state');

const source = fs.readFileSync(path.resolve(__dirname, '../src/jellyfin/resilient-provisioning.js'), 'utf8');

assert(
    source.includes("require('../entitlements/customer-access-desired-state')"),
    'canonical reconciler must import the shared desired-access-state calculator'
);
assert(
    source.includes('desiredAccessState.deriveCustomerAccessDesiredState({'),
    'canonical reconciler must derive desired access through the shared calculator'
);
assert(
    !source.includes('function blockerState('),
    'canonical reconciler must not maintain a second blocker-normalization implementation'
);
assert(
    !/const\s+activePlanIds\s*=\s*\[\s*primaryEntitlement/.test(source),
    'canonical reconciler must not rebuild Discord plan IDs independently from desired access state'
);
assert(
    source.includes('accountMatchesEntitlementPlacement(account, entitlement)'),
    'lane reconciliation must use the canonical exact-placement matcher'
);
assert(
    source.includes("const forcedServerId = entitlement?.admin_forced_server_id || null;"),
    'an administrator-forced server must be treated as an exact server id, not only as a server class'
);
assert(
    source.includes("error.code = 'RECONCILIATION_FORCED_SERVER_MISMATCH';"),
    'reconciliation postconditions must reject convergence on the wrong server while an admin pin is active'
);
assert(
    !source.includes('a.is_primary && a.server_class === entitlement.server_class && a.server_enabled'),
    'lane selection must not let an existing same-class server override an exact admin pin'
);

const paid = { plan_id: 'paid', is_free_tier: false, blocked: false };
const free = { plan_id: 'free', is_free_tier: true, blocked: false };
const stremio = { plan_id: 'stremio', blocked: false };
const emby = { plan_id: 'emby', blocked: true };
const derived = desiredState.deriveCustomerAccessDesiredState({
    effectiveJellyfin: paid,
    freeEntitlement: free,
    stremioEntitlement: stremio,
    embyEntitlement: emby,
    holds: [{ hold_type: 'payment_delinquency', source_key: 'emby:test' }]
});

assert.strictEqual(derived.primaryEntitlement, paid, 'paid Jellyfin entitlement must remain the primary lane');
assert.strictEqual(derived.controlEntitlement, paid, 'control entitlement precedence must remain paid → free → Stremio → Emby');
assert.deepStrictEqual(derived.activePlanIds, ['paid', 'free', 'stremio'], 'blocked service plans must not be assigned through Discord desired state');
assert.deepStrictEqual(derived.blockers.map(row => row.type), ['payment_delinquency'], 'typed blockers must be normalized once by the shared calculator');

console.log('reconciliation desired-state ownership smoke: ok');