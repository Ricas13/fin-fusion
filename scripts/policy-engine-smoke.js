'use strict';

// Pure-logic regression tests for src/jellyfin/policy.js -- the engine that
// decides PLAN -> ADMIN OVERRIDE -> CUSTOMER DESELECTION -> EFFECTIVE for
// both technical policy and library entitlement. No DB/network involved, so
// these run anywhere and specifically cover the escalation/fail-closed
// guarantees called out in the Phase 3C spec.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const policy = require('../src/jellyfin/policy');
const subscriptionState = require('../src/entitlements/subscription-state');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function main() {
    const plan = {
        library_access_mode: 'include',
        library_names: ['Movies', 'TV'],
        streams: 3,
        allow_downloads: true,
        allow_video_transcoding: false,
        allow_audio_transcoding: true,
        allow_remuxing: false,
        allow_live_tv: false,
        allow_live_tv_management: false,
        allow_remote_access: true
    };
    const catalog = ['Movies', 'TV', 'Anime', '4K Movies'];

    // #3 admin can override policy upwards (plan says No, override says Yes).
    {
        const rows = policy.effectiveTechnicalPolicy(plan, { allow_video_transcoding: true });
        assert.strictEqual(rows.allow_video_transcoding.plan, false);
        assert.strictEqual(rows.allow_video_transcoding.override, true);
        assert.strictEqual(rows.allow_video_transcoding.effective, true, 'override must be able to grant upward');
    }

    // #4 admin can override policy downwards (plan says Yes, override says No).
    {
        const rows = policy.effectiveTechnicalPolicy(plan, { allow_downloads: false });
        assert.strictEqual(rows.allow_downloads.plan, true);
        assert.strictEqual(rows.allow_downloads.override, false);
        assert.strictEqual(rows.allow_downloads.effective, false, 'override must be able to restrict downward');
    }

    // #5 Reset to Plan (override field back to null/undefined) removes the
    // override and effective reverts to the plan value.
    {
        const overridden = policy.effectiveTechnicalPolicy(plan, { allow_downloads: false });
        assert.strictEqual(overridden.allow_downloads.effective, false);
        const reset = policy.effectiveTechnicalPolicy(plan, { allow_downloads: null });
        assert.strictEqual(reset.allow_downloads.override, null, 'reset override must read back as null (inherit)');
        assert.strictEqual(reset.allow_downloads.effective, plan.allow_downloads, 'effective must revert to plan value after reset');
    }

    // Library entitlement: plan grants Movies/TV only; per-library override
    // can both grant something the plan doesn't (4K Movies, upward) and
    // revoke something the plan does grant (TV, downward).
    const libOverrides = [
        { library_name: '4K Movies', granted: true },
        { library_name: 'TV', granted: false }
    ];
    const entitlement = policy.libraryEntitlement(plan, libOverrides, catalog);
    const byName = Object.fromEntries(entitlement.map(row => [row.name, row]));
    assert.strictEqual(byName['Movies'].plan, true);
    assert.strictEqual(byName['Movies'].effective, true, 'ungranted-by-override library keeps plan grant');
    assert.strictEqual(byName['TV'].plan, true);
    assert.strictEqual(byName['TV'].override, false);
    assert.strictEqual(byName['TV'].effective, false, 'library override must be able to revoke downward');
    assert.strictEqual(byName['4K Movies'].plan, false);
    assert.strictEqual(byName['4K Movies'].override, true);
    assert.strictEqual(byName['4K Movies'].effective, true, 'library override must be able to grant upward');
    assert.strictEqual(byName['Anime'].effective, false, 'library neither in plan nor overridden must stay ungranted');

    // #1 / #2 customer cannot enable a library outside effective entitlement,
    // even via a crafted request naming an arbitrary/unknown library.
    {
        const noSelection = policy.customerVisibleLibraries(entitlement, null);
        assert.deepStrictEqual(new Set(noSelection), new Set(['Movies', '4K Movies']), 'with no preference, full entitlement is visible');

        const crafted = policy.customerVisibleLibraries(entitlement, { selected_names: ['Movies', 'Anime', 'Nonexistent Library', 'TV'] });
        assert.ok(!crafted.includes('Anime'), 'a library outside entitlement must never appear despite being requested');
        assert.ok(!crafted.includes('Nonexistent Library'), 'an arbitrary/unknown library name must never appear');
        assert.ok(!crafted.includes('TV'), 'a library revoked by admin override must never appear even if requested');
        assert.deepStrictEqual(new Set(crafted), new Set(['Movies']), 'only the entitled+requested intersection is ever visible');
    }

    // #6 customer deselection only ever narrows within their entitlement --
    // deselecting everything then re-selecting something in-entitlement works,
    // but nothing outside entitlement can ever be added back.
    {
        const deselectedAll = policy.customerVisibleLibraries(entitlement, { selected_names: [] });
        assert.deepStrictEqual(deselectedAll, [], 'deselecting everything hides everything');
        const reselected = policy.customerVisibleLibraries(entitlement, { selected_names: ['4K Movies'] });
        assert.deepStrictEqual(reselected, ['4K Movies'], 're-selecting an entitled library restores it');
    }

    // #9 / #10 a library missing from a specific server's live catalog must
    // never fall back to unrestricted/broadened access -- it's just omitted.
    {
        const serverFolders = [{ id: 'folder-1', name: 'Movies' }]; // server is missing "4K Movies"
        const resolved = policy.resolveNamesToIds(['Movies', '4K Movies'], serverFolders);
        assert.deepStrictEqual(resolved.enabledFolders, ['folder-1']);
        assert.deepStrictEqual(resolved.missing, ['4K Movies'], 'missing library must be reported, not silently dropped without trace');
        // Critically: resolveNamesToIds has no "grant everything" fallback --
        // its return shape never includes an EnableAllFolders-equivalent flag,
        // so a caller physically cannot broaden access from a missing name.
        assert.ok(!('enableAllFolders' in resolved), 'resolveNamesToIds must never itself signal unrestricted access');

        const emptyServer = policy.resolveNamesToIds(['Movies'], []);
        assert.deepStrictEqual(emptyServer.enabledFolders, [], 'a server with zero discovered folders grants nothing, not everything');
        assert.deepStrictEqual(emptyServer.missing, ['Movies']);
    }

    // #18 bulk library Add must never touch libraries outside what was asked
    // for; only Replace may also revoke libraries outside the picked set.
    {
        const addPlan = policy.libraryOverridePlan('add', ['Anime'], catalog);
        assert.deepStrictEqual(addPlan, [{ name: 'Anime', granted: true }], 'Add must touch only the requested library');

        const removePlan = policy.libraryOverridePlan('remove', ['Movies'], catalog);
        assert.deepStrictEqual(removePlan, [{ name: 'Movies', granted: false }], 'Remove must touch only the requested library');

        const replacePlan = policy.libraryOverridePlan('replace', ['Anime'], catalog);
        const replaceByName = Object.fromEntries(replacePlan.map(x => [x.name, x.granted]));
        assert.strictEqual(replaceByName['Anime'], true, 'Replace grants the requested library');
        assert.strictEqual(replaceByName['Movies'], false, 'Replace revokes libraries outside the requested set');
        assert.strictEqual(replaceByName['TV'], false, 'Replace revokes libraries outside the requested set');
        assert.strictEqual(replaceByName['4K Movies'], false, 'Replace revokes libraries outside the requested set');
        assert.strictEqual(Object.keys(replaceByName).length, catalog.length, 'Replace must produce a decision for the entire catalog');

        // An Add request naming a library outside the discovered catalog
        // (crafted/unknown) must be dropped, never applied.
        const addUnknown = policy.libraryOverridePlan('add', ['Totally Made Up'], catalog);
        assert.deepStrictEqual(addUnknown, [], 'Add must silently drop names outside the discovered catalog');
    }

    // Serious media-policy regressions: provider type, PAYG/recurring identity,
    // and Free/Premium household lanes must never collapse into one another.
    {
        const fourK = read('src/jellyfin/four-k-transcode-policy.js');
        const payg = read('src/jellyfin/payg-expiry-messages.js');
        const household = read('src/jellyfin/household-network-policy.js');
        const worker = read('scripts/activity-worker.js');

        assert(!fourK.includes("COALESCE(js.media_server_type,'jellyfin')='jellyfin'"), '4K transcode enforcement must not silently exclude Emby servers');
        assert(fourK.includes('/Sessions/${encodeURIComponent(candidate.Id)}/Playing/Stop'), '4K enforcement must continue through the shared media-server registry path');

        assert.strictEqual(subscriptionState.recurringProvider({ source: 'stripe', provider_subscription_id: 'sub_123' }), true, 'Stripe sub_* is recurring');
        assert.strictEqual(subscriptionState.recurringProvider({ source: 'stripe', provider_subscription_id: 'pi_123' }), false, 'Stripe PaymentIntent is PAYG, not recurring');
        assert.strictEqual(subscriptionState.recurringProvider({ source: 'paypal', provider_subscription_id: 'I-ABC123' }), true, 'PayPal I-* is recurring');
        assert.strictEqual(subscriptionState.recurringProvider({ source: 'paypal', provider_subscription_id: 'PAY-123' }), false, 'PayPal one-time payment ID is PAYG');
        assert.strictEqual(subscriptionState.recurringProvider({ source: 'plisio', provider_subscription_id: 'txn-123' }), false, 'Plisio transactions are PAYG');
        assert(payg.includes("s.source IN ('stripe','paypal','plisio')"), 'PAYG reminders must include Plisio one-time purchases');
        assert(payg.includes("s.source='stripe' AND COALESCE(s.provider_subscription_id,'') ~* '^sub_'") && payg.includes("s.source='paypal' AND COALESCE(s.provider_subscription_id,'') ~* '^I-'"), 'PAYG reminders must exclude only canonical provider recurring identifiers');
        assert(!payg.includes('s.provider_subscription_id IS NULL'), 'PAYG reminders must not mistake non-null one-time payment IDs for recurring subscriptions');

        assert(household.includes('aps.device_name,ja.access_lane'), 'household sessions must carry the owning Jellyfin lane');
        assert(household.includes("(CASE WHEN p.is_free_tier THEN 'free' ELSE 'primary' END)=$2"), 'household entitlement lookup must be scoped to Free versus primary lane');
        assert(household.includes('failedServerIds.has(String(session.server_id))'), 'household enforcement must skip only the server whose poll failed');
        assert(worker.includes('runHouseholdNetworkCycle({ failedServerIds })'), 'activity worker must pass per-server failure identity to household enforcement');
        assert(!worker.includes('runHouseholdNetworkCycle({ pollsReliable: !failedServerIds.length })'), 'one unrelated server failure must not disable household enforcement fleet-wide');
    }

    console.log('Policy engine smoke test passed.');
}

main();
