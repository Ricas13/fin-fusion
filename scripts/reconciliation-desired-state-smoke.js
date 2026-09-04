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
assert(
    source.includes('const freeLaneEntitlement = jellyfinRemovedByAdmin && freeEntitlement'),
    'explicit removal of the current paid Jellyfin entitlement must suppress free-lane fallback during reconciliation'
);
assert(
    source.includes('freeEntitlement.blocked || accounts.some'),
    'blocked or operator-suppressed free access must not adopt another account into the free lane'
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

const removedPaid = { ...paid, blocked: true, admin_jellyfin_removed: true };
const removed = desiredState.deriveCustomerAccessDesiredState({
    effectiveJellyfin: removedPaid,
    freeEntitlement: free,
    stremioEntitlement: stremio,
    embyEntitlement: null
});
assert.strictEqual(removed.jellyfinRemovedByAdmin, true, 'explicit paid-lane removal must be surfaced as customer-wide Jellyfin suppression');
assert.strictEqual(removed.desired.primaryJellyfin, false, 'removed paid Jellyfin lane must stay disabled');
assert.strictEqual(removed.desired.freeJellyfin, false, 'Free Server must not silently restore Jellyfin after an explicit operator removal');
assert.strictEqual(removed.desired.stremio, true, 'Jellyfin removal must not suppress unrelated Stremio access');
assert.deepStrictEqual(removed.activePlanIds, ['stremio'], 'Discord desired roles must not keep paid/free Jellyfin plan roles after explicit Jellyfin removal');

console.log('reconciliation desired-state ownership smoke: ok');