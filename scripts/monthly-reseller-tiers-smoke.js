'use strict';

const bcrypt = require('bcryptjs');
const { query, transaction, getPool } = require('../src/db');
const monthly = require('../src/resellers/monthly');
const resellerJobs = require('../src/resellers/jobs');
const portal = require('../src/platform/reseller-monthly-portal');
const storefront = require('../src/platform/reseller-storefront');

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
        const customer = await client.query(`INSERT INTO customers(reseller_id,display_name,is_reseller_owner) VALUES($1,$2,$3) RETURNING *`, [resellerId, name, owner]);
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
            INSERT INTO reseller_tiers(code,name,description,monthly_price_minor,currency,seat_limit,active,visible,sort_order)
            VALUES($1,'Smoke Business','Monthly recurring reseller tier',6000,'GBP',2,TRUE,TRUE,10)
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

        const third = (await query(`INSERT INTO customers(reseller_id,display_name) VALUES($1,'Smoke third') RETURNING id`, [reseller.id])).rows[0];
        let full = false;
        try {
            await transaction(client => monthly.assertSeatAvailable(client, reseller.id, third.id));
        } catch (error) {
            full = /tier is full/i.test(error.message);
        }
        assert(full, 'Seat-cap enforcement allowed a third active account into a two-seat tier');
        await query('DELETE FROM customers WHERE id=$1', [third.id]);

        await query(`INSERT INTO reseller_sales(reseller_id,customer_id,plan_id,amount_minor,currency,payment_method,service_ends_at) VALUES($1,$2,$3,650,'GBP','Bank transfer',NOW()+INTERVAL '30 days')`, [reseller.id, child.id, plan.id]);
        const stats = await portal.analytics(reseller.id, { start: new Date(Date.now() - 86400000), end: new Date(Date.now() + 1000), days: 1 });
        assert(Number(stats.primary.amount_minor) === 650 && Number(stats.primary.sales) === 1, 'Reseller downstream revenue analytics are incorrect');

        const section = storefront.resellerSection([{ ...tier, provider_prices: [{ provider: 'stripe', active: true }] }], 'support@example.com');
        assert(section.includes('Smoke Business') && section.includes('2 active Jellyfin accounts') && section.includes('/ month'), 'Public reseller tier card did not render dynamically');

        const mapping = await monthly.providerMapping(tier.id, 'stripe');
        assert(mapping?.external_id === 'price_smoke_monthly', 'Recurring Stripe tier mapping did not resolve');

        let archiveBlocked = false;
        try { await query('UPDATE reseller_tiers SET active=FALSE WHERE id=$1', [tier.id]); }
        catch (error) { archiveBlocked = /active subscriptions/i.test(error.message); }
        assert(archiveBlocked, 'A tier with a live paid reseller subscription could be archived');

        await query(`UPDATE reseller_subscriptions SET status='cancelled',cancel_at_period_end=TRUE WHERE id=$1`, [manual.id]);
        const paidThrough = (await query('SELECT status,cancel_at_period_end FROM reseller_subscriptions WHERE id=$1', [manual.id])).rows[0];
        assert(paidThrough.status === 'active' && paidThrough.cancel_at_period_end === true, 'Paid-through cancellation revoked reseller entitlement early');

        await query(`UPDATE customers SET access_paused_at=NOW(),access_hold_reason=$2 WHERE id=$1`, [child.id, `${monthly.MANUAL_HOLD_PREFIX}${reseller.id}`]);
        await query(`UPDATE reseller_subscriptions SET status='expired',cancel_at_period_end=FALSE,current_period_end=NOW()-INTERVAL '1 minute' WHERE id=$1`, [manual.id]);
        await monthly.reconcileEstate(reseller.id);
        const held = await query('SELECT id,access_paused_at,access_hold_reason FROM customers WHERE id=ANY($1::uuid[]) ORDER BY id', [[owner.id, child.id]]);
        const ownerHeld = held.rows.find(x => String(x.id) === String(owner.id));
        const childHeld = held.rows.find(x => String(x.id) === String(child.id));
        assert(ownerHeld.access_paused_at && ownerHeld.access_hold_reason === `${monthly.ESTATE_HOLD_PREFIX}${reseller.id}`, 'Expired reseller subscription did not suspend owner access');
        assert(childHeld.access_hold_reason === `${monthly.MANUAL_HOLD_PREFIX}${reseller.id}`, 'Estate suspension overwrote an intentional manual customer hold');

        await query(`UPDATE reseller_subscriptions SET status='active',current_period_end=NOW()+INTERVAL '30 days' WHERE id=$1`, [manual.id]);
        await monthly.reconcileEstate(reseller.id);
        const restored = await query('SELECT id,access_paused_at,access_hold_reason FROM customers WHERE id=ANY($1::uuid[])', [[owner.id, child.id]]);
        const ownerRestored = restored.rows.find(x => String(x.id) === String(owner.id));
        const childStillHeld = restored.rows.find(x => String(x.id) === String(child.id));
        assert(!ownerRestored.access_paused_at && !ownerRestored.access_hold_reason, 'Restored reseller payment did not restore estate-created hold');
        assert(childStillHeld.access_paused_at && childStillHeld.access_hold_reason === `${monthly.MANUAL_HOLD_PREFIX}${reseller.id}`, 'Payment restoration incorrectly cleared an independent manual hold');

        // Deployment safety: a legacy reseller that has never entered the monthly
        // subscription model must not be touched by the new recurring job.
        const legacyCustomer = (await query(`INSERT INTO customers(reseller_id,display_name) VALUES($1,'Legacy child') RETURNING *`, [legacy.reseller.id])).rows[0];
        await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')`, [legacyCustomer.id, plan.id]);
        await resellerJobs.reconcileSubscribedEstates();
        const legacyState = (await query('SELECT access_paused_at,access_hold_reason FROM customers WHERE id=$1', [legacyCustomer.id])).rows[0];
        assert(!legacyState.access_paused_at && !legacyState.access_hold_reason, 'Monthly reseller deployment suspended a legacy reseller with no monthly subscription record');

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
