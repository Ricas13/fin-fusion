'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');
const provisioning = require('../jellyfin/provisioning');

const ESTATE_HOLD_PREFIX = 'reseller_subscription:';
const MANUAL_HOLD_PREFIX = 'reseller_manual:';

function cleanText(value, max = 500) {
    return String(value || '').trim().slice(0, max);
}

function moneyMinor(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new Error('Enter a valid amount charged.');
    return Math.round(n * 100);
}

function cleanCurrency(value, fallback = 'GBP') {
    const v = String(value || fallback).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(v)) throw new Error('Currency must be a three-letter code.');
    return v;
}

function statusIsEntitled(row) {
    return Boolean(row && row.status === 'active' && new Date(row.current_period_end).getTime() > Date.now());
}

async function listTiers({ visibleOnly = false, activeOnly = false } = {}) {
    const clauses = [];
    if (visibleOnly) clauses.push('t.visible=TRUE');
    if (activeOnly) clauses.push('t.active=TRUE');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await query(`
        SELECT t.*,
               COALESCE(jsonb_agg(jsonb_build_object('provider',p.provider,'externalId',p.external_id,'active',p.active))
                   FILTER (WHERE p.id IS NOT NULL),'[]'::jsonb) provider_prices
        FROM reseller_tiers t
        LEFT JOIN reseller_tier_provider_prices p ON p.tier_id=t.id
        ${where}
        GROUP BY t.id
        ORDER BY t.active DESC,t.sort_order,t.seat_limit,t.name
    `);
    return result.rows;
}

async function tierById(tierId) {
    const result = await query('SELECT * FROM reseller_tiers WHERE id=$1', [tierId]);
    return result.rows[0] || null;
}

async function tierByCode(code) {
    const result = await query('SELECT * FROM reseller_tiers WHERE code=$1 AND active=TRUE', [String(code || '').trim()]);
    return result.rows[0] || null;
}

async function currentSubscription(resellerId) {
    const result = await query(`
        SELECT rs.*,rt.code AS tier_code,rt.name AS tier_name,rt.seat_limit,
               rt.monthly_price_minor,rt.currency
        FROM reseller_subscriptions rs
        JOIN reseller_tiers rt ON rt.id=rs.tier_id
        WHERE rs.reseller_id=$1
        ORDER BY
            CASE WHEN rs.status='active' AND rs.current_period_end>NOW() THEN 0 ELSE 1 END,
            rs.current_period_end DESC,rs.created_at DESC
        LIMIT 1
    `, [resellerId]);
    return result.rows[0] || null;
}

async function seatUsage(resellerId, client = null) {
    const runner = client || { query };
    const result = await runner.query(`
        SELECT COUNT(DISTINCT c.id)::int AS used
        FROM customers c
        WHERE c.reseller_id=$1
          AND c.access_paused_at IS NULL
          AND EXISTS (
              SELECT 1 FROM subscriptions s
              WHERE s.customer_id=c.id
                AND s.status IN ('active','trialing','past_due')
                AND s.current_period_end>NOW()
          )
    `, [resellerId]);
    return Number(result.rows[0]?.used || 0);
}

async function resellerEntitlement(resellerId, client = null) {
    const runner = client || { query };
    const result = await runner.query(`
        SELECT rs.*,rt.name AS tier_name,rt.code AS tier_code,rt.seat_limit,rt.monthly_price_minor,rt.currency
        FROM reseller_subscriptions rs
        JOIN reseller_tiers rt ON rt.id=rs.tier_id
        WHERE rs.reseller_id=$1 AND rt.active=TRUE
        ORDER BY
            CASE WHEN rs.status='active' AND rs.current_period_end>NOW() THEN 0 ELSE 1 END,
            rs.current_period_end DESC,rs.created_at DESC
        LIMIT 1
    `, [resellerId]);
    const row = result.rows[0] || null;
    return { row, active: statusIsEntitled(row) };
}

async function customerIsActive(customerId, client) {
    const result = await client.query(`
        SELECT EXISTS(
            SELECT 1 FROM customers c
            JOIN subscriptions s ON s.customer_id=c.id
            WHERE c.id=$1 AND c.access_paused_at IS NULL
              AND s.status IN ('active','trialing','past_due') AND s.current_period_end>NOW()
        ) AS active
    `, [customerId]);
    return Boolean(result.rows[0]?.active);
}

async function assertSeatAvailable(client, resellerId, customerId = null) {
    const locked = await client.query('SELECT id FROM resellers WHERE id=$1 FOR UPDATE', [resellerId]);
    if (!locked.rowCount) throw new Error('Reseller not found.');
    const entitlement = await resellerEntitlement(resellerId, client);
    if (!entitlement.active) throw new Error('Your reseller subscription is not active. Renew it before activating customers.');
    const alreadyActive = customerId ? await customerIsActive(customerId, client) : false;
    const used = await seatUsage(resellerId, client);
    if (!alreadyActive && used >= Number(entitlement.row.seat_limit)) {
        throw new Error(`Your ${entitlement.row.tier_name} tier is full (${used}/${entitlement.row.seat_limit} active accounts). Upgrade your reseller subscription to add another customer.`);
    }
    return { entitlement: entitlement.row, used, alreadyActive };
}

async function customerIdsForEstate(resellerId) {
    const result = await query(`
        SELECT DISTINCT c.id
        FROM customers c
        LEFT JOIN resellers r ON r.id=$1
        WHERE c.reseller_id=$1 OR c.id=r.own_customer_id
        ORDER BY c.id
    `, [resellerId]);
    return result.rows.map(r => r.id);
}

async function reconcileIds(ids) {
    const results = [];
    for (const id of ids) {
        try {
            await provisioning.reconcileCustomer(id);
            results.push({ customerId: id, ok: true });
        } catch (error) {
            results.push({ customerId: id, ok: false, error: error.message });
        }
    }
    return results;
}

async function suspendEstate(resellerId, reason = 'Reseller subscription is not active') {
    const hold = `${ESTATE_HOLD_PREFIX}${resellerId}`;
    const ids = await customerIdsForEstate(resellerId);
    await transaction(async client => {
        await client.query(`
            UPDATE customers
            SET access_paused_at=COALESCE(access_paused_at,NOW()),access_hold_reason=$2
            WHERE (reseller_id=$1 OR id=(SELECT own_customer_id FROM resellers WHERE id=$1))
              AND (access_hold_reason IS NULL OR access_hold_reason LIKE 'reseller_subscription:%')
        `, [resellerId, hold]);
        await client.query(`
            UPDATE resellers SET estate_suspended_at=COALESCE(estate_suspended_at,NOW()),estate_suspend_reason=$2
            WHERE id=$1
        `, [resellerId, cleanText(reason, 500)]);
        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('reseller.estate.suspend','reseller',$1,$2::jsonb)
        `, [resellerId, JSON.stringify({ reason, customers: ids.length })]);
    });
    return { customers: ids.length, reconciliation: await reconcileIds(ids) };
}

async function restoreEstate(resellerId) {
    const hold = `${ESTATE_HOLD_PREFIX}${resellerId}`;
    const ids = await customerIdsForEstate(resellerId);
    await transaction(async client => {
        await client.query(`
            UPDATE customers SET access_paused_at=NULL,access_hold_reason=NULL
            WHERE (reseller_id=$1 OR id=(SELECT own_customer_id FROM resellers WHERE id=$1))
              AND access_hold_reason=$2
        `, [resellerId, hold]);
        await client.query('UPDATE resellers SET estate_suspended_at=NULL,estate_suspend_reason=NULL WHERE id=$1', [resellerId]);
        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('reseller.estate.restore','reseller',$1,$2::jsonb)
        `, [resellerId, JSON.stringify({ customers: ids.length })]);
    });
    return { customers: ids.length, reconciliation: await reconcileIds(ids) };
}

async function reconcileEstate(resellerId) {
    const entitlement = await resellerEntitlement(resellerId);
    if (entitlement.active) return restoreEstate(resellerId);
    const reason = entitlement.row
        ? `Reseller subscription ${entitlement.row.status}; paid access ended ${new Date(entitlement.row.current_period_end).toISOString()}`
        : 'No active reseller subscription';
    return suspendEstate(resellerId, reason);
}

async function reconcileAllEstates() {
    const result = await query('SELECT id FROM resellers ORDER BY id');
    const summary = { total: result.rowCount, active: 0, suspended: 0, failed: 0 };
    for (const row of result.rows) {
        try {
            const entitlement = await resellerEntitlement(row.id);
            await reconcileEstate(row.id);
            if (entitlement.active) summary.active += 1;
            else summary.suspended += 1;
        } catch (error) {
            summary.failed += 1;
            console.error(`Reseller estate reconcile failed for ${row.id}:`, error.message);
        }
    }
    return summary;
}

async function setProviderSubscription({ resellerId, tierId, provider, providerCustomerId = null, providerSubscriptionId, providerStatus, periodStart = null, periodEnd, cancelAtPeriodEnd = false }) {
    if (!['stripe','paypal'].includes(provider)) throw new Error('Unsupported reseller billing provider.');
    if (!providerSubscriptionId) throw new Error('Provider subscription ID is required.');
    const end = periodEnd ? new Date(periodEnd) : null;
    if (!end || !Number.isFinite(end.getTime())) throw new Error('Provider did not return a valid paid-through date.');
    const normalized = String(providerStatus || '').toLowerCase();
    const status = ['active','trialing'].includes(normalized)
        ? 'active'
        : ['past_due','unpaid','suspended','payment_failed'].includes(normalized)
            ? 'past_due'
            : ['cancelled','canceled'].includes(normalized)
                ? 'cancelled'
                : ['expired','inactive'].includes(normalized)
                    ? 'expired'
                    : 'pending';
    const row = await transaction(async client => {
        const found = await client.query(`
            SELECT id FROM reseller_subscriptions
            WHERE source=$1 AND provider_subscription_id=$2 FOR UPDATE
        `, [provider, providerSubscriptionId]);
        let saved;
        if (found.rowCount) {
            saved = await client.query(`
                UPDATE reseller_subscriptions
                SET tier_id=$2,status=$3,current_period_end=$4,cancel_at_period_end=$5,
                    provider_customer_id=COALESCE($6,provider_customer_id),provider_status=$7,
                    last_provider_sync_at=NOW(),last_provider_error=NULL,updated_at=NOW()
                WHERE id=$1 RETURNING *
            `, [found.rows[0].id, tierId, status, end, Boolean(cancelAtPeriodEnd), providerCustomerId, providerStatus || null]);
        } else {
            saved = await client.query(`
                INSERT INTO reseller_subscriptions(
                    reseller_id,tier_id,status,source,starts_at,current_period_end,cancel_at_period_end,
                    provider_customer_id,provider_subscription_id,provider_status,last_provider_sync_at
                ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *
            `, [resellerId, tierId, status, provider, periodStart ? new Date(periodStart) : new Date(), end, Boolean(cancelAtPeriodEnd), providerCustomerId, providerSubscriptionId, providerStatus || null]);
        }
        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('reseller.subscription.provider_sync','reseller_subscription',$1,$2::jsonb)
        `, [saved.rows[0].id, JSON.stringify({ resellerId, tierId, provider, providerStatus, status, periodEnd: end.toISOString() })]);
        return saved.rows[0];
    });
    await reconcileEstate(resellerId);
    return row;
}

async function updateKnownProviderSubscription({ provider, providerSubscriptionId, providerStatus, periodEnd = null, cancelAtPeriodEnd = false }) {
    const found = await query(`
        SELECT rs.*,rt.id AS tier_id
        FROM reseller_subscriptions rs JOIN reseller_tiers rt ON rt.id=rs.tier_id
        WHERE rs.source=$1 AND rs.provider_subscription_id=$2
        ORDER BY rs.created_at DESC LIMIT 1
    `, [provider, providerSubscriptionId]);
    if (!found.rowCount) return null;
    const row = found.rows[0];
    return setProviderSubscription({
        resellerId: row.reseller_id,
        tierId: row.tier_id,
        provider,
        providerCustomerId: row.provider_customer_id,
        providerSubscriptionId,
        providerStatus,
        periodStart: row.starts_at,
        periodEnd: periodEnd || row.current_period_end,
        cancelAtPeriodEnd
    });
}

async function createManualTierSubscription({ resellerId, tierId, months = 1, actorUserId = null }) {
    const count = Number.parseInt(months, 10);
    if (!Number.isInteger(count) || count < 1 || count > 36) throw new Error('Months must be between 1 and 36.');
    const tier = await tierById(tierId);
    if (!tier || !tier.active) throw new Error('Choose an active reseller tier.');
    const row = await transaction(async client => {
        const locked = await client.query('SELECT id FROM resellers WHERE id=$1 FOR UPDATE', [resellerId]);
        if (!locked.rowCount) throw new Error('Reseller not found.');
        const existing = await client.query(`
            SELECT * FROM reseller_subscriptions
            WHERE reseller_id=$1 AND source='manual' AND status='active'
            ORDER BY current_period_end DESC LIMIT 1 FOR UPDATE
        `, [resellerId]);
        const now = new Date();
        const base = existing.rowCount && new Date(existing.rows[0].current_period_end) > now ? new Date(existing.rows[0].current_period_end) : now;
        const end = new Date(base);
        end.setUTCMonth(end.getUTCMonth() + count);
        let saved;
        if (existing.rowCount) {
            saved = await client.query(`
                UPDATE reseller_subscriptions SET tier_id=$2,current_period_end=$3,status='active',updated_at=NOW()
                WHERE id=$1 RETURNING *
            `, [existing.rows[0].id, tierId, end]);
        } else {
            saved = await client.query(`
                INSERT INTO reseller_subscriptions(reseller_id,tier_id,status,source,starts_at,current_period_end)
                VALUES($1,$2,'active','manual',$3,$4) RETURNING *
            `, [resellerId, tierId, now, end]);
        }
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.reseller.subscription.manual','reseller_subscription',$2,$3::jsonb)
        `, [actorUserId, saved.rows[0].id, JSON.stringify({ resellerId, tierId, months: count, periodEnd: end.toISOString() })]);
        return saved.rows[0];
    });
    await reconcileEstate(resellerId);
    return row;
}

async function getResellerCustomer(resellerId, customerId) {
    const result = await query('SELECT * FROM customers WHERE id=$1 AND reseller_id=$2', [customerId, resellerId]);
    return result.rows[0] || null;
}

async function createOrRenewCustomer({ resellerId, customerId = null, username = null, planCode, amount, currency = 'GBP', paymentMethod = 'other', note = '', actorUserId = null, owner = false }) {
    const cleanUsername = cleanText(username, 40);
    if (!customerId && !/^[A-Za-z0-9._-]{3,40}$/.test(cleanUsername)) throw new Error('Enter a valid Jellyfin username.');
    const amountMinor = moneyMinor(amount || 0);
    const cleanCurrencyCode = cleanCurrency(currency);
    const method = cleanText(paymentMethod || 'other', 50) || 'other';
    const cleanNote = cleanText(note, 500);

    const saved = await transaction(async client => {
        const planResult = await client.query(`
            SELECT * FROM plans
            WHERE code=$1 AND active=TRUE AND audience IN ('reseller','both')
            FOR SHARE
        `, [String(planCode || '').trim()]);
        if (!planResult.rowCount) throw new Error('Choose an active reseller-enabled customer plan.');
        const plan = planResult.rows[0];

        let customer;
        if (customerId) {
            const found = await client.query('SELECT * FROM customers WHERE id=$1 AND reseller_id=$2 FOR UPDATE', [customerId, resellerId]);
            if (!found.rowCount) throw new Error('Customer not found.');
            customer = found.rows[0];
        } else if (owner) {
            const reseller = await client.query(`
                SELECT r.*,u.username,u.email FROM resellers r JOIN app_users u ON u.id=r.user_id
                WHERE r.id=$1 FOR UPDATE OF r
            `, [resellerId]);
            if (!reseller.rowCount) throw new Error('Reseller not found.');
            if (reseller.rows[0].own_customer_id) {
                const existingOwner = await client.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE', [reseller.rows[0].own_customer_id]);
                customer = existingOwner.rows[0];
            } else {
                const createdOwner = await client.query(`
                    INSERT INTO customers(user_id,reseller_id,display_name,email,is_reseller_owner)
                    VALUES($1,$2,$3,$4,TRUE) RETURNING *
                `, [reseller.rows[0].user_id, resellerId, reseller.rows[0].username, reseller.rows[0].email]);
                customer = createdOwner.rows[0];
                await client.query('UPDATE resellers SET own_customer_id=$2 WHERE id=$1', [resellerId, customer.id]);
            }
        } else {
            const created = await client.query(`
                INSERT INTO customers(reseller_id,display_name,note)
                VALUES($1,$2,$3) RETURNING *
            `, [resellerId, cleanUsername, cleanNote]);
            customer = created.rows[0];
        }

        const seats = await assertSeatAvailable(client, resellerId, customer.id);
        const existing = await client.query(`
            SELECT * FROM subscriptions
            WHERE customer_id=$1 AND status IN ('active','trialing','past_due')
            ORDER BY current_period_end DESC LIMIT 1 FOR UPDATE
        `, [customer.id]);
        const now = new Date();
        const base = existing.rowCount && new Date(existing.rows[0].current_period_end) > now
            ? new Date(existing.rows[0].current_period_end)
            : now;
        const end = new Date(base.getTime() + Number(plan.duration_days || 30) * 86400000);
        let subscription;
        if (existing.rowCount) {
            subscription = (await client.query(`
                UPDATE subscriptions SET plan_id=$2,status='active',source='manual',current_period_end=$3,updated_at=NOW()
                WHERE id=$1 RETURNING *
            `, [existing.rows[0].id, plan.id, end])).rows[0];
        } else {
            subscription = (await client.query(`
                INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
                VALUES($1,$2,'active','manual',$3,$4) RETURNING *
            `, [customer.id, plan.id, now, end])).rows[0];
        }
        if (customer.access_hold_reason === `${MANUAL_HOLD_PREFIX}${resellerId}`) {
            await client.query('UPDATE customers SET access_paused_at=NULL,access_hold_reason=NULL WHERE id=$1', [customer.id]);
        }
        const sale = await client.query(`
            INSERT INTO reseller_sales(reseller_id,customer_id,plan_id,amount_minor,currency,payment_method,service_starts_at,service_ends_at,note)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
        `, [resellerId, customer.id, plan.id, amountMinor, cleanCurrencyCode, method, base, end, owner ? 'Reseller own access' : cleanNote]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'reseller.customer.sale','customer',$2,$3::jsonb)
        `, [actorUserId, customer.id, JSON.stringify({ resellerId, planCode: plan.code, amountMinor, currency: cleanCurrencyCode, paymentMethod: method, serviceEndsAt: end.toISOString(), seatLimit: seats.entitlement.seat_limit })]);
        return { customer, plan, subscription, sale: sale.rows[0], seats };
    });

    const reconcile = await provisioning.reconcileCustomer(saved.customer.id);
    return { ...saved, reconcile };
}

async function setCustomerManualSuspended({ resellerId, customerId, suspended, actorUserId = null }) {
    const hold = `${MANUAL_HOLD_PREFIX}${resellerId}`;
    const updated = await transaction(async client => {
        const found = await client.query('SELECT id,access_hold_reason FROM customers WHERE id=$1 AND reseller_id=$2 FOR UPDATE', [customerId, resellerId]);
        if (!found.rowCount) throw new Error('Customer not found.');
        if (suspended) {
            await client.query(`UPDATE customers SET access_paused_at=COALESCE(access_paused_at,NOW()),access_hold_reason=$2 WHERE id=$1`, [customerId, hold]);
        } else {
            await client.query(`UPDATE customers SET access_paused_at=NULL,access_hold_reason=NULL WHERE id=$1 AND access_hold_reason=$2`, [customerId, hold]);
        }
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`, [actorUserId, suspended ? 'reseller.customer.suspend' : 'reseller.customer.resume', customerId, JSON.stringify({ resellerId })]);
        return true;
    });
    await provisioning.reconcileCustomer(customerId);
    return updated;
}

async function salesAnalytics(resellerId, { from, to }) {
    const start = new Date(from);
    const end = new Date(to);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) throw new Error('Invalid reporting period.');
    const [totals, daily, newCustomers, playback, topCustomers] = await Promise.all([
        query(`SELECT currency,SUM(amount_minor)::bigint amount_minor,COUNT(*)::int sales FROM reseller_sales WHERE reseller_id=$1 AND created_at>=$2 AND created_at<$3 GROUP BY currency ORDER BY currency`, [resellerId, start, end]),
        query(`SELECT date_trunc('day',created_at)::date day,currency,SUM(amount_minor)::bigint amount_minor FROM reseller_sales WHERE reseller_id=$1 AND created_at>=$2 AND created_at<$3 GROUP BY 1,2 ORDER BY 1,2`, [resellerId, start, end]),
        query('SELECT COUNT(*)::int n FROM customers WHERE reseller_id=$1 AND created_at>=$2 AND created_at<$3', [resellerId, start, end]),
        query(`SELECT COALESCE(SUM(ph.duration_seconds),0)::bigint seconds,COUNT(*)::int sessions,COUNT(DISTINCT ph.customer_id)::int viewers FROM playback_history ph JOIN customers c ON c.id=ph.customer_id WHERE c.reseller_id=$1 AND ph.started_at>=$2 AND ph.started_at<$3`, [resellerId, start, end]),
        query(`SELECT c.id,c.display_name,COALESCE(SUM(rs.amount_minor),0)::bigint revenue_minor,COUNT(rs.id)::int sales FROM customers c LEFT JOIN reseller_sales rs ON rs.customer_id=c.id AND rs.created_at>=$2 AND rs.created_at<$3 WHERE c.reseller_id=$1 GROUP BY c.id ORDER BY revenue_minor DESC,c.display_name LIMIT 10`, [resellerId, start, end])
    ]);
    return { totals: totals.rows, daily: daily.rows, newCustomers: Number(newCustomers.rows[0]?.n || 0), playback: playback.rows[0], topCustomers: topCustomers.rows };
}

async function listManagedCustomers(resellerId) {
    const result = await query(`
        SELECT c.id,c.display_name,c.email,c.note,c.is_reseller_owner,c.access_paused_at,c.access_hold_reason,c.created_at,
               s.status AS sub_status,s.current_period_end,p.code AS plan_code,p.name AS plan_name,
               ja.jellyfin_username,js.name AS server_name,
               COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams
        FROM customers c
        LEFT JOIN LATERAL (SELECT * FROM subscriptions WHERE customer_id=c.id ORDER BY current_period_end DESC LIMIT 1) s ON TRUE
        LEFT JOIN plans p ON p.id=s.plan_id
        LEFT JOIN LATERAL (SELECT * FROM jellyfin_accounts WHERE customer_id=c.id ORDER BY is_primary DESC,created_at ASC LIMIT 1) ja ON TRUE
        LEFT JOIN jellyfin_servers js ON js.id=ja.server_id
        LEFT JOIN active_playback_sessions aps ON aps.customer_id=c.id
        WHERE c.reseller_id=$1
        GROUP BY c.id,s.id,p.id,ja.id,js.id
        ORDER BY c.is_reseller_owner DESC,c.created_at DESC
    `, [resellerId]);
    return result.rows;
}

async function providerMapping(tierId, provider) {
    const result = await query(`
        SELECT p.*,t.name AS tier_name,t.monthly_price_minor,t.currency,t.seat_limit
        FROM reseller_tier_provider_prices p JOIN reseller_tiers t ON t.id=p.tier_id
        WHERE p.tier_id=$1 AND p.provider=$2 AND p.active=TRUE AND t.active=TRUE
    `, [tierId, provider]);
    return result.rows[0] || null;
}

function randomCheckoutKey() {
    return crypto.randomUUID();
}

module.exports = {
    ESTATE_HOLD_PREFIX,
    MANUAL_HOLD_PREFIX,
    cleanText,
    moneyMinor,
    cleanCurrency,
    listTiers,
    tierById,
    tierByCode,
    currentSubscription,
    resellerEntitlement,
    seatUsage,
    assertSeatAvailable,
    suspendEstate,
    restoreEstate,
    reconcileEstate,
    reconcileAllEstates,
    setProviderSubscription,
    updateKnownProviderSubscription,
    createManualTierSubscription,
    createOrRenewCustomer,
    setCustomerManualSuspended,
    salesAnalytics,
    listManagedCustomers,
    providerMapping,
    randomCheckoutKey,
    getResellerCustomer
};