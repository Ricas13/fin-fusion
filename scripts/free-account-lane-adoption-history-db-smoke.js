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
// only genuine same-lane history counts as evidence.

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const inactivity = require('../src/automation/customer-inactivity');

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

(async () => {
    const serverId = await makeServer('a');
    // Only one is_free_tier=TRUE plan may exist at a time
    // (plans_single_free_tier_idx) -- both cases reuse the seeded canonical
    // Free plan rather than inserting a second one.
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

    console.log('free account lane-adoption history DB smoke: ok');
})().finally(async () => {
    for (const customerId of created.customers.reverse()) {
        await query('DELETE FROM playback_history WHERE customer_id=$1', [customerId]).catch(() => {});
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
