'use strict';

// DB-backed regression test for a real production incident: a customer who
// cancels a paid Jellyfin plan but keeps Free entitlement gets their existing
// (paid-lane) Jellyfin account reused for the Free lane via
// resilient-provisioning.js's adoptExistingFreeAccount(), which flips
// access_lane on the SAME jellyfin_accounts row rather than creating a new
// one. Before this fix, src/automation/customer-inactivity.js's allocation
// scoping ("historical" playback lookback, broadened in commit 14bcd021 to
// apply to any Free subscription, not just migration imports) picked up that
// account's PAID-era playback_history as "established Free activation
// evidence", pushing allocation_start_at back to the old paid usage and
// making the customer immediately eligible for automatic Free Server removal
// on the very next inactivity sweep -- despite never having watched anything
// as a Free customer.
//
// The fix adds jellyfin_accounts.access_lane_changed_at (set by
// adoptExistingFreeAccount whenever it performs the lane flip) and scopes the
// historical lookback to playback recorded at-or-after that timestamp, so
// only genuine same-lane history counts as evidence. A later corrective
// migration marks only pre-column Free rows whose historical lane boundary was
// inherently ambiguous; those rows receive a full retention observation window
// without rewriting access_lane_changed_at.

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const inactivity = require('../src/automation/customer-inactivity');
const inactivityGrace = require('../src/entitlements/jellyfin-inactivity-grace');
const subscriptionState = require('../src/entitlements/subscription-state');

const suffix = crypto.randomBytes(4).toString('hex');
const created = { customers: [], plans: [], servers: [] };
const GLOBAL_CFG = { enabled: true, dryRun: false, freeFirstPlaybackGraceDays: 3, freeNoPlaybackDays: 7, freeMinimumPlaybackMinutes: 30, freePlaybackWindowDays: 7 };

async function makeServer(label) {
    const row = await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users)
        VALUES($1,$2,'premium',$3,'jf1:smoke',TRUE,TRUE) RETURNING id
    `, [`Lane adoption ${label} ${suffix}`, `lane-adoption-${label}-${suffix}`, `https://lane-adoption-${label}-${suffix}.invalid`]);
    created.servers.push(row.rows[0].id);
    return row.rows[0].id;
}

// plans_single_free_tier_idx allows exactly one is_free_tier=TRUE row across
// the whole database, and this schema always seeds a canonical "Free Access"
// plan -- reuse it rather than trying to insert a second one.
async function canonicalFreePlanId() {
    const row = await query(`SELECT id FROM plans WHERE is_free_tier=TRUE LIMIT 1`);
    if (!row.rowCount) throw new Error('No canonical is_free_tier=TRUE plan found in this database.');
    return row.rows[0].id;
}

async function makeCustomer(label) {
    const row = await query(
        `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
        [`Lane Adoption ${label} ${suffix}`, `lane-adoption-${label}-${suffix}@example.invalid`]
    );
    created.customers.push(row.rows[0].id);
    return row.rows[0].id;
}

async function candidateFor(customerId) {
    const rows = await inactivity.candidates(GLOBAL_CFG, { customerId });
    return rows.find(row => String(row.customer_id) === String(customerId)) || null;
}

async function candidateWithGrace(customerId) {
    const rows = await inactivityGrace.applyRestorationGrace(await inactivity.candidates(GLOBAL_CFG, { customerId }));
    return rows.find(row => String(row.customer_id) === String(customerId)) || null;
}

(async () => {
    const serverId = await makeServer('a');
    // Only one is_free_tier=TRUE plan may exist at a time
    // (plans_single_free_tier_idx) -- all cases reuse the seeded canonical
    // Free plan rather than inserting another one.
    const planId = await canonicalFreePlanId();

    // Case 1: account reused from the PAID (primary) lane via
    // adoptExistingFreeAccount. Its playback_history predates the lane flip
    // by 190 days -- exactly the paid-era usage that must NOT count as Free
    // activation evidence.
    const customerId = await makeCustomer('reused');
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW()-INTERVAL '200 days',NOW()+INTERVAL '3650 days')
    `, [customerId, planId]);
    const account = (await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,is_primary,created_at,access_lane_changed_at)
        VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',TRUE,NOW()-INTERVAL '200 days',NOW())
        RETURNING id
    `, [customerId, serverId, `lane-adopt-${suffix}`, `lane-adopt-${suffix}`])).rows[0];
    await query(`
        INSERT INTO playback_history(customer_id,server_id,jellyfin_account_id,playback_key,jellyfin_session_id,item_name,item_type,device_name,client_name,playback_method,started_at,last_seen_at,ended_at)
        VALUES($1,$2,$3,$4,$5,'Smoke Movie','Movie','Living Room TV','Jellyfin Web','directplay',NOW()-INTERVAL '190 days',NOW()-INTERVAL '190 days'+INTERVAL '20 minutes',NOW()-INTERVAL '190 days'+INTERVAL '20 minutes')
    `, [customerId, serverId, account.id, `lane-adopt-paid-era-${suffix}`, `lane-adopt-paid-era-session-${suffix}`]);

    const reused = await candidateFor(customerId);
    assert(reused, 'a Free customer with a reused (lane-adopted) account must still surface as a scan candidate');
    assert.strictEqual(reused.has_playback, false, 'PAID-era playback recorded before the lane flip must not count as established Free activation evidence');
    assert.strictEqual(reused.eligible, false, 'a just-adopted Free account must not be immediately eligible for removal because of stale pre-flip paid playback');
    const allocationAgeMs = Date.now() - new Date(reused.allocation_start_at).getTime();
    assert(allocationAgeMs >= 0 && allocationAgeMs < 5 * 60000, `allocation_start_at must track the lane-flip time (access_lane_changed_at), not the old paid playback timestamp; was ${reused.allocation_start_at}`);

    // Case 2: an account that has ALWAYS been Free-lane, with real Free-lane
    // playback history, must still recognize that established history as
    // activation evidence -- proving the fix did not regress the legitimate
    // same-lane-resubscribe scenario commit 14bcd021 was written for.
    const alwaysCustomerId = await makeCustomer('always-free');
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW()-INTERVAL '1 day',NOW()+INTERVAL '3650 days')
    `, [alwaysCustomerId, planId]);
    const alwaysAccount = (await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,is_primary,created_at,access_lane_changed_at)
        VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',TRUE,NOW()-INTERVAL '60 days',NOW()-INTERVAL '60 days')
        RETURNING id
    `, [alwaysCustomerId, serverId, `lane-always-${suffix}`, `lane-always-${suffix}`])).rows[0];
    await query(`
        INSERT INTO playback_history(customer_id,server_id,jellyfin_account_id,playback_key,jellyfin_session_id,item_name,item_type,device_name,client_name,playback_method,started_at,last_seen_at,ended_at)
        VALUES($1,$2,$3,$4,$5,'Smoke Movie','Movie','Living Room TV','Jellyfin Web','directplay',NOW()-INTERVAL '2 days',NOW()-INTERVAL '2 days'+INTERVAL '20 minutes',NOW()-INTERVAL '2 days'+INTERVAL '20 minutes')
    `, [alwaysCustomerId, serverId, alwaysAccount.id, `lane-always-play-${suffix}`, `lane-always-session-${suffix}`]);

    const always = await candidateFor(alwaysCustomerId);
    assert(always, 'an always-Free customer with real playback history must still surface as a scan candidate');
    assert.strictEqual(always.has_playback, true, 'established same-lane Free playback history must still count as activation evidence');
    assert.strictEqual(always.eligible, false, 'a Free customer with recent same-lane playback must not be removal-eligible');

    // Case 3: pre-column Free rows can have an access_lane_changed_at backfill
    // newer than their genuine Free playback. The base scanner would therefore
    // classify this established user as "never played" and, once the 3-day
    // first-play threshold passes, make them eligible. The corrective marker
    // must suppress that destructive decision for the FULL 7-day retention
    // window; rewriting access_lane_changed_at to NOW() would only restart the
    // shorter 3-day first-play clock and recreate the same class of bug later.
    const legacyCustomerId = await makeCustomer('legacy-backfill');
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW()-INTERVAL '90 days',NOW()+INTERVAL '3650 days')
    `, [legacyCustomerId, planId]);
    const legacyAccount = (await query(`
        INSERT INTO jellyfin_accounts(
            customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,is_primary,
            created_at,access_lane_changed_at,inactivity_observation_reset_at
        )
        VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',TRUE,NOW()-INTERVAL '90 days',NOW()-INTERVAL '4 days',NOW())
        RETURNING id
    `, [legacyCustomerId, serverId, `lane-legacy-${suffix}`, `lane-legacy-${suffix}`])).rows[0];
    await query(`
        INSERT INTO playback_history(customer_id,server_id,jellyfin_account_id,playback_key,jellyfin_session_id,item_name,item_type,device_name,client_name,playback_method,started_at,last_seen_at,ended_at)
        VALUES($1,$2,$3,$4,$5,'Smoke Movie','Movie','Living Room TV','Jellyfin Web','directplay',NOW()-INTERVAL '5 days',NOW()-INTERVAL '5 days'+INTERVAL '20 minutes',NOW()-INTERVAL '5 days'+INTERVAL '20 minutes')
    `, [legacyCustomerId, serverId, legacyAccount.id, `lane-legacy-play-${suffix}`, `lane-legacy-session-${suffix}`]);

    const legacyBase = await candidateFor(legacyCustomerId);
    assert(legacyBase, 'legacy backfilled Free account must surface as a scan candidate');
    assert.strictEqual(legacyBase.has_playback, false, 'playback before the ambiguous backfilled lane boundary must remain excluded by the normal scanner');
    assert.strictEqual(legacyBase.eligible, true, 'fixture must prove the old 3-day first-play path would otherwise remove this established legacy user');

    const legacyProtected = await candidateWithGrace(legacyCustomerId);
    assert(legacyProtected, 'legacy backfilled Free account must remain visible after safety grace decoration');
    assert.strictEqual(legacyProtected.eligible, false, 'legacy safety window must suppress destructive inactivity enforcement');
    assert.strictEqual(legacyProtected.restoration_grace_source, 'legacy_lane_backfill', 'legacy safety must be distinguishable from an administrator restore');
    const remainingMs = new Date(legacyProtected.restoration_grace_until).getTime() - Date.now();
    assert(remainingMs > 6 * 86400000, `legacy safety must use the full retention window, not the 3-day first-play window; remaining=${remainingMs}`);

    // Rolling-window overlap: a session that begins just before the window
    // still contributes only the portion actually observed inside the window.
    const overlapCustomerId = await makeCustomer('rolling-overlap');
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW()-INTERVAL '30 days',NOW()+INTERVAL '3650 days')
    `, [overlapCustomerId, planId]);
    const overlapAccount = (await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,is_primary,created_at,access_lane_changed_at)
        VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',TRUE,NOW()-INTERVAL '30 days',NOW()-INTERVAL '30 days')
        RETURNING id
    `, [overlapCustomerId, serverId, `lane-overlap-${suffix}`, `lane-overlap-${suffix}`])).rows[0];
    await query(`
        INSERT INTO playback_history(customer_id,server_id,jellyfin_account_id,playback_key,jellyfin_session_id,item_name,item_type,device_name,client_name,playback_method,started_at,last_seen_at,ended_at)
        VALUES(
            $1,$2,$3,$4,$5,'Boundary Movie','Movie','Living Room TV','Jellyfin Web','directplay',
            NOW()-INTERVAL '7 days 20 minutes',
            NOW()-INTERVAL '6 days 23 hours 20 minutes',
            NOW()-INTERVAL '6 days 23 hours 20 minutes'
        )
    `, [overlapCustomerId, serverId, overlapAccount.id, `lane-overlap-play-${suffix}`, `lane-overlap-session-${suffix}`]);
    const overlap = await candidateFor(overlapCustomerId);
    assert(overlap, 'boundary-overlap Free customer must surface as a scan candidate');
    const overlapMinutes = Number(overlap.playback_seconds || 0) / 60;
    assert(overlapMinutes >= 39 && overlapMinutes <= 41, `rolling usage must count only the ~40 minutes inside the window; got ${overlapMinutes}`);
    assert.strictEqual(overlap.eligible, false, 'a customer with at least 30 minutes inside the rolling window must not be removal-eligible');

    // The overlap fix must not weaken allocation scoping. A stream that began
    // before a paid->Free lane transition remains entirely pre-allocation data.
    const crossingCustomerId = await makeCustomer('allocation-crossing');
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW()-INTERVAL '30 days',NOW()+INTERVAL '3650 days')
    `, [crossingCustomerId, planId]);
    const crossingAccount = (await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,is_primary,created_at,access_lane_changed_at)
        VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',TRUE,NOW()-INTERVAL '30 days',NOW()-INTERVAL '10 minutes')
        RETURNING id
    `, [crossingCustomerId, serverId, `lane-crossing-${suffix}`, `lane-crossing-${suffix}`])).rows[0];
    await query(`
        INSERT INTO playback_history(customer_id,server_id,jellyfin_account_id,playback_key,jellyfin_session_id,item_name,item_type,device_name,client_name,playback_method,started_at,last_seen_at,ended_at)
        VALUES(
            $1,$2,$3,$4,$5,'Paid-to-Free Crossing','Movie','Living Room TV','Jellyfin Web','directplay',
            NOW()-INTERVAL '20 minutes',
            NOW()-INTERVAL '1 minute',
            NOW()-INTERVAL '1 minute'
        )
    `, [crossingCustomerId, serverId, crossingAccount.id, `lane-crossing-play-${suffix}`, `lane-crossing-session-${suffix}`]);
    const crossing = await candidateFor(crossingCustomerId);
    assert(crossing, 'allocation-crossing customer must surface as a scan candidate');
    assert.strictEqual(crossing.has_playback, false, 'a session started before the Free lane transition must not activate the new Free allocation');
    assert.strictEqual(Number(crossing.playback_seconds || 0), 0, 'the tail of a pre-allocation paid session must not count toward Free rolling usage');
    assert.strictEqual(crossing.eligible, false, 'a newly transitioned Free allocation must remain in first-play grace');

    // A server pin controls placement only. It must not defeat a Free
    // inactivity hold or resurrect an expired Free entitlement. Explicit
    // admin-present and permanent access remain true access grants.
    const pinnedCustomerId = await makeCustomer('pinned-inactive');
    const pinnedSubscription = (await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','migration',NOW()-INTERVAL '30 days',NOW()+INTERVAL '3650 days')
        RETURNING id
    `, [pinnedCustomerId, planId])).rows[0];
    await query(`
        INSERT INTO customer_service_admin_control(customer_id,service,mode,server_id,reason)
        VALUES($1,'jellyfin','admin_server_pin',$2,'Smoke pinned Free placement')
    `, [pinnedCustomerId, serverId]);
    await query(`
        INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason,metadata)
        VALUES($1,'inactivity_policy',$2,'Smoke Free inactivity','{}'::jsonb)
    `, [pinnedCustomerId, `plan:${planId}`]);

    let pinned = await subscriptionState.liveFreeJellyfinSubscription(pinnedCustomerId, { includeBlocked: true });
    assert(pinned, 'pinned Free entitlement must remain discoverable for blocked-state reconciliation');
    assert.strictEqual(pinned.admin_jellyfin_mode, 'forced_server');
    assert.strictEqual(pinned.blocked, true, 'server pin must not override a Free inactivity hold');
    assert.strictEqual(await subscriptionState.liveFreeJellyfinSubscription(pinnedCustomerId), null, 'blocked pinned Free access must disappear from normal entitlement lookup');

    await query(`
        INSERT INTO customer_entitlement_overrides(customer_id,subscription_id,permanent_access,reason)
        VALUES($1,$2,TRUE,'Smoke permanent Free access')
    `, [pinnedCustomerId, pinnedSubscription.id]);
    pinned = await subscriptionState.liveFreeJellyfinSubscription(pinnedCustomerId);
    assert(pinned, 'permanent access must remain authoritative while the account is server-pinned');
    assert.strictEqual(pinned.permanent_access, true);
    assert.strictEqual(pinned.blocked, false);

    await query('DELETE FROM customer_entitlement_overrides WHERE customer_id=$1', [pinnedCustomerId]);
    await query(`
        UPDATE subscriptions SET status='expired',current_period_end=NOW()-INTERVAL '1 day',updated_at=NOW()
        WHERE id=$1
    `, [pinnedSubscription.id]);
    assert.strictEqual(
        await subscriptionState.liveFreeJellyfinSubscription(pinnedCustomerId, { includeBlocked: true }),
        null,
        'server pin must not resurrect an otherwise expired Free entitlement'
    );

    await query(`
        UPDATE customer_service_admin_control
        SET mode='admin_present',server_id=NULL,reason='Smoke explicit present',updated_at=NOW()
        WHERE customer_id=$1 AND service='jellyfin'
    `, [pinnedCustomerId]);
    pinned = await subscriptionState.liveFreeJellyfinSubscription(pinnedCustomerId);
    assert(pinned, 'explicit admin-present must still extend and protect an otherwise expired Free entitlement');
    assert.strictEqual(pinned.admin_jellyfin_mode, 'present');
    assert.strictEqual(pinned.blocked, false);

    console.log('free account lane-adoption history DB smoke: ok');
})().finally(async () => {
    for (const customerId of created.customers.reverse()) {
        await query('DELETE FROM playback_history WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM customer_access_holds WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM customer_service_admin_control WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM customer_entitlement_overrides WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM jellyfin_accounts WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM subscriptions WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
    }
    for (const planId of created.plans.reverse()) {
        await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
    }
    for (const serverId of created.servers.reverse()) {
        await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
    }
    await getPool().end();
}).catch((error) => {
    console.error('free account lane-adoption history DB smoke failed:', error);
    process.exit(1);
});
