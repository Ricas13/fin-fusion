'use strict';

const bcrypt = require('bcryptjs');
const { query, transaction, getPool } = require('../src/db');
const monthly = require('../src/resellers/monthly');
const resellerJobs = require('../src/resellers/jobs');
const accessHolds = require('../src/entitlements/access-holds');
const storefront = require('../src/platform/storefront');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const USERNAMES = ['smoke-reseller-monthly', 'smoke-reseller-legacy'];
const PLAN_CODE = 'smoke-reseller-child-plan';
const TIER_CODE = 'smoke-monthly-tier';

async function cleanup() {
    await query("DELETE FROM reseller_sales WHERE reseller_id IN (SELECT r.id FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE u.username=ANY($1::text[]))", [USERNAMES]);
    await query("DELETE FROM reseller_subscriptions WHERE reseller_id IN (SELECT r.id FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE u.username=ANY($1::text[]))", [USERNAMES]);
    await query("DELETE FROM customers WHERE reseller_id IN (SELECT r.id FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE u.username=ANY($1::text[]))", [USERNAMES]);
    await query("DELETE FROM reseller_tier_provider_prices WHERE tier_id IN (SELECT id FROM reseller_tiers WHERE code=$1)", [TIER_CODE]);
    await query("DELETE FROM reseller_tiers WHERE code=$1", [TIER_CODE]);
    await query("DELETE FROM resellers WHERE user_id IN (SELECT id FROM app_users WHERE username=ANY($1::text[]))", [USERNAMES]);
    await query("DELETE FROM app_users WHERE username=ANY($1::text[])", [USERNAMES]);
    await query('DELETE FROM plans WHERE code=$1', [PLAN_CODE]);
}

async function createReseller(username) {
    const hash = await bcrypt.hash('SmokePassword123!', 4);
    return transaction(async client => {
        const user = await client.query(`INSERT INTO app_users(username,password_hash,role,active) VALUES($1,$2,'reseller',TRUE) RETURNING id`, [username, hash]);
        const reseller = await client.query('INSERT INTO resellers(user_id) VALUES($1) RETURNING *', [user.rows[0].id]);
        return { userId: user.rows[0].id, reseller: reseller.rows[0] };
    });
}

async function createActiveCustomer(resellerId, planId, name, owner = false) {
    return transaction(async client => {
        const customer = await client.query(`INSERT INTO customers(reseller_id,display_name,is_reseller_owner,reseller_managed) VALUES($1,$2,$3,TRUE) RETURNING *`, [resellerId, name, owner]);
        if (owner) await client.query('UPDATE resellers SET own_customer_id=$2 WHERE id=$1', [resellerId, customer.rows[0].id]);
        await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')`, [customer.rows[0].id, planId]);
        return customer.rows[0];
    });
}

async function main() {
    await cleanup();
    try {
        const plan = (await query(`
            INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,allow_remuxing,allow_remote_access)
            VALUES($1,'Smoke reseller customer plan','reseller','month',30,600,'GBP',3,'premium',TRUE,TRUE,FALSE,TRUE)
            RETURNING *
        `, [PLAN_CODE])).rows[0];

        const tier = (await query(`
            INSERT INTO reseller_tiers(code,name,description,monthly_price_minor,currency,seat_limit,active,visible,sort_order,streams,server_class,allow_video_transcoding,library_access_mode)
            VALUES($1,'Smoke Business','Monthly managed-user reseller licence',6000,'GBP',2,TRUE,TRUE,10,5,'premium',FALSE,'all')
            RETURNING *
        `, [TIER_CODE])).rows[0];
        await query(`INSERT INTO reseller_tier_provider_prices(tier_id,provider,external_id) VALUES($1,'stripe','price_smoke_monthly')`, [tier.id]);

        const { reseller } = await createReseller(USERNAMES[0]);
        const legacy = await createReseller(USERNAMES[1]);

        const manual = await monthly.createManualTierSubscription({ resellerId: reseller.id, tierId: tier.id, months: 1 });
        assert(manual.status === 'active', 'Manual monthly reseller entitlement did not activate');
        const entitlement = await monthly.resellerEntitlement(reseller.id);
        assert(entitlement.active && Number(entitlement.row.seat_limit) === 2, 'Active reseller tier/seat allowance not resolved');

        const owner = await createActiveCustomer(reseller.id, plan.id, 'Smoke owner', true);
        const child = await createActiveCustomer(reseller.id, plan.id, 'Smoke child');
        assert(await monthly.seatUsage(reseller.id) === 2, 'Owner + child did not consume two active reseller seats');

        const third = (await query(`INSERT INTO customers(reseller_id,display_name,reseller_managed) VALUES($1,'Smoke third',TRUE) RETURNING id`, [reseller.id])).rows[0];
        let full = false;
        try {
            await transaction(client => monthly.assertSeatAvailable(client, reseller.id, third.id));
        } catch (error) {
            full = /tier is full/i.test(error.message);
        }
        assert(full, 'Seat-cap enforcement allowed a third active account into a two-seat tier');
        await query('DELETE FROM customers WHERE id=$1', [third.id]);

        const section = storefront.resellerSection([{ ...tier, provider_prices: [{ provider: 'stripe', active: true }], inventory: { limit: 5, used: 0, remaining: 5, soldOut: false } }], 'support@example.com');
        assert(section.includes('Smoke Business') && section.includes('2 managed Jellyfin users') && section.includes('5 concurrent streams per managed user') && section.includes('Video transcoding disabled') && section.includes('/ month'), 'Public managed-user reseller tier card did not render its seat and Jellyfin policy dynamically');
        assert(section.includes('downstream billing and customer administration stay outside CAPTAiNFiN'), 'Reseller storefront must state that downstream reseller administration is external to CAPTAiNFiN');

        const mapping = await monthly.providerMapping(tier.id, 'stripe');
        assert(mapping?.external_id === 'price_smoke_monthly', 'Recurring Stripe tier mapping did not resolve');

        let archiveBlocked = false;
        try { await query('UPDATE reseller_tiers SET active=FALSE WHERE id=$1', [tier.id]); }
        catch (error) { archiveBlocked = /active subscriptions/i.test(error.message); }
        assert(archiveBlocked, 'A tier with a live paid reseller subscription could be archived');

        await query(`UPDATE reseller_subscriptions SET status='cancelled',cancel_at_period_end=TRUE WHERE id=$1`, [manual.id]);
        const paidThrough = (await query('SELECT status,cancel_at_period_end FROM reseller_subscriptions WHERE id=$1', [manual.id])).rows[0];
        assert(paidThrough.status === 'active' && paidThrough.cancel_at_period_end === true, 'Paid-through cancellation revoked reseller entitlement early');

        await accessHolds.addHold({
            customerId: child.id,
            type: 'reseller_manual',
            sourceKey: reseller.id,
            reason: 'Smoke manual reseller suspension',
            metadata: { resellerId: reseller.id }
        });
        assert(await monthly.seatUsage(reseller.id) === 2, 'Suspending customer access incorrectly freed a commercially occupied reseller seat');
        const heldThird = (await query(`INSERT INTO customers(reseller_id,display_name,reseller_managed) VALUES($1,'Smoke held third',TRUE) RETURNING id`, [reseller.id])).rows[0];
        let heldSeatFreed = false;
        try {
            await transaction(client => monthly.assertSeatAvailable(client, reseller.id, heldThird.id));
            heldSeatFreed = true;
        } catch (error) {
            if (!/tier is full/i.test(error.message)) throw error;
        }
        assert(!heldSeatFreed, 'A temporary access hold allowed the reseller to recycle a still-entitled seat');
        await query('DELETE FROM customers WHERE id=$1', [heldThird.id]);

        await query(`UPDATE reseller_subscriptions SET status='expired',cancel_at_period_end=FALSE,current_period_end=NOW()-INTERVAL '1 minute' WHERE id=$1`, [manual.id]);
        await monthly.reconcileEstate(reseller.id);

        const ownerHolds = await accessHolds.activeHolds(owner.id);
        const childHolds = await accessHolds.activeHolds(child.id);
        assert(ownerHolds.some(h => h.hold_type === 'reseller_subscription' && String(h.source_key) === String(reseller.id)), 'Expired reseller subscription did not add the estate hold to owner access');
        assert(childHolds.some(h => h.hold_type === 'reseller_manual' && String(h.source_key) === String(reseller.id)), 'Estate suspension overwrote the independent manual customer hold');
        assert(childHolds.some(h => h.hold_type === 'reseller_subscription' && String(h.source_key) === String(reseller.id)), 'Estate suspension did not coexist with the manual customer hold');

        await query(`UPDATE reseller_subscriptions SET status='active',current_period_end=NOW()+INTERVAL '30 days' WHERE id=$1`, [manual.id]);
        await monthly.reconcileEstate(reseller.id);
        const ownerRestored = await accessHolds.activeHolds(owner.id);
        const childStillHeld = await accessHolds.activeHolds(child.id);
        assert(!ownerRestored.some(h => h.hold_type === 'reseller_subscription'), 'Restored reseller payment did not release the estate-created hold');
        assert(childStillHeld.length === 1 && childStillHeld[0].hold_type === 'reseller_manual', 'Payment restoration incorrectly cleared or duplicated an independent manual hold');

        const legacyCustomer = (await query(`INSERT INTO customers(reseller_id,display_name) VALUES($1,'Legacy child') RETURNING *`, [legacy.reseller.id])).rows[0];
        await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')`, [legacyCustomer.id, plan.id]);
        await resellerJobs.reconcileSubscribedEstates();
        const legacyHolds = await accessHolds.activeHolds(legacyCustomer.id);
        assert(legacyHolds.length === 0, 'Monthly reseller deployment suspended a legacy reseller with no monthly subscription record');

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
