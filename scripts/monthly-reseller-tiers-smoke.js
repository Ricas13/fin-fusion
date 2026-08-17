'use strict';

const bcrypt = require('bcryptjs');
const { query, transaction, getPool } = require('../src/db');
const monthly = require('../src/resellers/monthly');
const managedUsers = require('../src/resellers/managed-users');
const resellerJobs = require('../src/resellers/jobs');
const accessHolds = require('../src/entitlements/access-holds');
const storefront = require('../src/platform/storefront');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const USERNAMES = ['smoke-reseller-monthly', 'smoke-reseller-legacy'];
const TIER_CODE = 'smoke-monthly-tier';

async function cleanup() {
    await query("DELETE FROM reseller_subscriptions WHERE reseller_id IN (SELECT r.id FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE u.username=ANY($1::text[]))", [USERNAMES]);
    await query("DELETE FROM customers WHERE reseller_id IN (SELECT r.id FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE u.username=ANY($1::text[]))", [USERNAMES]);
    await query("DELETE FROM reseller_tier_provider_prices WHERE tier_id IN (SELECT id FROM reseller_tiers WHERE code=$1)", [TIER_CODE]);
    await query("DELETE FROM reseller_tiers WHERE code=$1", [TIER_CODE]);
    await query("DELETE FROM resellers WHERE user_id IN (SELECT id FROM app_users WHERE username=ANY($1::text[]))", [USERNAMES]);
    await query("DELETE FROM app_users WHERE username=ANY($1::text[])", [USERNAMES]);
}

async function createReseller(username) {
    const hash = await bcrypt.hash('SmokePassword123!', 4);
    return transaction(async client => {
        const user = await client.query(`INSERT INTO app_users(username,password_hash,role,active) VALUES($1,$2,'reseller',TRUE) RETURNING id`, [username, hash]);
        const reseller = await client.query('INSERT INTO resellers(user_id) VALUES($1) RETURNING *', [user.rows[0].id]);
        return { userId: user.rows[0].id, reseller: reseller.rows[0] };
    });
}

async function createManagedCustomer(resellerId, name) {
    return (await query(`
        INSERT INTO customers(reseller_id,display_name,reseller_managed,note)
        VALUES($1,$2,TRUE,'Managed reseller smoke user')
        RETURNING *
    `, [resellerId, name])).rows[0];
}

async function main() {
    await cleanup();
    try {
        const tier = (await query(`
            INSERT INTO reseller_tiers(
                code,name,description,monthly_price_minor,currency,seat_limit,
                capacity_limit,streams,allow_video_transcoding,library_access_mode,
                active,visible,sort_order
            )
            VALUES($1,'Smoke Business','Monthly managed Jellyfin seats',6000,'GBP',2,
                   10,3,FALSE,'include',TRUE,TRUE,10)
            RETURNING *
        `, [TIER_CODE])).rows[0];
        await query(`INSERT INTO reseller_tier_provider_prices(tier_id,provider,external_id) VALUES($1,'stripe','price_smoke_monthly')`, [tier.id]);

        const { reseller } = await createReseller(USERNAMES[0]);
        const legacy = await createReseller(USERNAMES[1]);

        const manual = await monthly.createManualTierSubscription({ resellerId: reseller.id, tierId: tier.id, months: 1 });
        assert(manual.status === 'active', 'Manual monthly reseller entitlement did not activate');
        const entitlement = await monthly.resellerEntitlement(reseller.id);
        assert(entitlement.active && Number(entitlement.row.seat_limit) === 2, 'Active reseller tier/seat allowance not resolved');

        const first = await createManagedCustomer(reseller.id, 'Smoke managed one');
        const second = await createManagedCustomer(reseller.id, 'Smoke managed two');
        assert(await managedUsers.seatUsage(reseller.id) === 2, 'Two managed Jellyfin users did not consume two seats');

        let full = false;
        try {
            await transaction(client => managedUsers.assertSeatAvailable(client, reseller.id));
        } catch (error) {
            full = /plan is full/i.test(error.message);
        }
        assert(full, 'Managed-seat enforcement allowed a third user into a two-seat reseller plan');

        await accessHolds.addHold({
            customerId: second.id,
            type: 'reseller_manual',
            sourceKey: reseller.id,
            reason: 'Smoke reseller suspension',
            metadata: { resellerId: reseller.id }
        });
        assert(await managedUsers.seatUsage(reseller.id) === 2, 'Suspending a managed user incorrectly released its reseller seat');

        const section = storefront.resellerSection([{ ...tier, inventory: { used: 1, limit: 10, remaining: 9, soldOut: false } }], 'support@example.com');
        assert(section.includes('Smoke Business'), 'Public reseller plan card did not render');
        assert(section.includes('2 managed Jellyfin users'), 'Reseller storefront did not describe the managed-user allowance');
        assert(section.includes('3 concurrent streams per managed user'), 'Reseller storefront did not expose the per-user stream limit');
        assert(section.includes('Video transcoding disabled'), 'Reseller storefront did not expose the plan transcoding policy');
        assert(section.includes('/ month'), 'Reseller storefront did not show monthly billing');

        const mapping = await monthly.providerMapping(tier.id, 'stripe');
        assert(mapping?.external_id === 'price_smoke_monthly', 'Recurring Stripe tier mapping did not resolve');

        let archiveBlocked = false;
        try { await query('UPDATE reseller_tiers SET active=FALSE WHERE id=$1', [tier.id]); }
        catch (error) { archiveBlocked = /active subscriptions/i.test(error.message); }
        assert(archiveBlocked, 'A reseller plan with a live paid subscription could be archived');

        await query(`UPDATE reseller_subscriptions SET status='cancelled',cancel_at_period_end=TRUE WHERE id=$1`, [manual.id]);
        const paidThrough = (await query('SELECT status,cancel_at_period_end FROM reseller_subscriptions WHERE id=$1', [manual.id])).rows[0];
        assert(paidThrough.status === 'active' && paidThrough.cancel_at_period_end === true, 'Paid-through cancellation revoked reseller entitlement early');

        await query(`UPDATE reseller_subscriptions SET status='expired',cancel_at_period_end=FALSE,current_period_end=NOW()-INTERVAL '1 minute' WHERE id=$1`, [manual.id]);
        await monthly.reconcileEstate(reseller.id);

        const firstHolds = await accessHolds.activeHolds(first.id);
        const secondHolds = await accessHolds.activeHolds(second.id);
        assert(firstHolds.some(h => h.hold_type === 'reseller_subscription' && String(h.source_key) === String(reseller.id)), 'Expired reseller subscription did not suspend a managed user');
        assert(secondHolds.some(h => h.hold_type === 'reseller_manual' && String(h.source_key) === String(reseller.id)), 'Estate suspension overwrote the independent manual managed-user hold');
        assert(secondHolds.some(h => h.hold_type === 'reseller_subscription' && String(h.source_key) === String(reseller.id)), 'Estate suspension did not coexist with the manual managed-user hold');

        await query(`UPDATE reseller_subscriptions SET status='active',current_period_end=NOW()+INTERVAL '30 days' WHERE id=$1`, [manual.id]);
        await monthly.reconcileEstate(reseller.id);
        const firstRestored = await accessHolds.activeHolds(first.id);
        const secondStillHeld = await accessHolds.activeHolds(second.id);
        assert(!firstRestored.some(h => h.hold_type === 'reseller_subscription'), 'Restored reseller payment did not release the estate-created hold');
        assert(secondStillHeld.length === 1 && secondStillHeld[0].hold_type === 'reseller_manual', 'Payment restoration incorrectly cleared or duplicated an independent managed-user hold');

        const legacyUser = await createManagedCustomer(legacy.reseller.id, 'Legacy managed user');
        await resellerJobs.reconcileSubscribedEstates();
        const legacyHolds = await accessHolds.activeHolds(legacyUser.id);
        assert(legacyHolds.length === 0, 'Monthly reseller deployment suspended a legacy reseller with no monthly subscription record');

        const legacySales = await query(`SELECT COUNT(*)::int n FROM reseller_sales WHERE reseller_id=$1`, [reseller.id]);
        assert(Number(legacySales.rows[0].n) === 0, 'Managed-seat workflow unexpectedly wrote a downstream reseller sale');

        console.log('monthly reseller tiers smoke: ok');
    } finally {
        await cleanup();
        await getPool().end();
    }
}

main().catch(async error => {
    console.error(error);
    try { await cleanup(); } catch (_) {}
    try { await getPool().end(); } catch (_) {}
    process.exit(1);
});
