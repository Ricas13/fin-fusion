'use strict';

const core = require('./monthly-core');
const { query, transaction } = require('../db');
const provisioning = require('../jellyfin/provisioning');
const accessHolds = require('../entitlements/access-holds');
const subscriptionState = require('../entitlements/subscription-state');
const resellerSettings = require('./settings');

const ESTATE_HOLD = 'reseller_subscription';
const MANUAL_HOLD = 'reseller_manual';

function entitled(row) {
    if (!row) return false;
    const now = Date.now();
    if (row.status === 'active' && new Date(row.current_period_end).getTime() > now) return true;
    if (row.status === 'past_due' && row.grace_until && new Date(row.grace_until).getTime() > now) return true;
    return false;
}

async function currentSubscription(resellerId, client = null) {
    const db = client || { query };
    const result = await db.query(`
        SELECT rs.*,rt.code AS tier_code,
               COALESCE(rs.tier_name_snapshot,rt.name) AS tier_name,
               COALESCE(rs.seat_limit_snapshot,rt.seat_limit) AS seat_limit,
               COALESCE(rs.monthly_price_minor_snapshot,rt.monthly_price_minor) AS monthly_price_minor,
               COALESCE(rs.currency_snapshot,rt.currency) AS currency,
               COALESCE(rs.grace_days_snapshot,rt.grace_days,0) AS grace_days
        FROM reseller_subscriptions rs JOIN reseller_tiers rt ON rt.id=rs.tier_id
        WHERE rs.reseller_id=$1
        ORDER BY
          CASE
            WHEN rs.status='active' AND rs.current_period_end>NOW() THEN 0
            WHEN rs.status='past_due' AND rs.grace_until>NOW() THEN 1
            ELSE 2
          END,
          rs.current_period_end DESC,rs.created_at DESC
        LIMIT 1
    `, [resellerId]);
    return result.rows[0] || null;
}

async function resellerEntitlement(resellerId, client = null) {
    const row = await currentSubscription(resellerId, client);
    return { row, active: entitled(row), inGrace: Boolean(row?.status === 'past_due' && row?.grace_until && new Date(row.grace_until) > new Date()) };
}

async function seatUsage(resellerId, client = null) {
    const db = client || { query };
    const result = await db.query(`
        SELECT COUNT(DISTINCT c.id)::int AS used
        FROM customers c
        WHERE c.reseller_id=$1
          AND NOT EXISTS (SELECT 1 FROM customer_access_holds h WHERE h.customer_id=c.id AND h.released_at IS NULL)
          AND EXISTS (
              SELECT 1 FROM subscriptions s
              WHERE s.customer_id=c.id AND s.superseded_by IS NULL
                AND s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW()
          )
    `, [resellerId]);
    return Number(result.rows[0]?.used || 0);
}

async function customerActive(customerId, client) {
    const result = await client.query(`SELECT EXISTS(
        SELECT 1 FROM customers c WHERE c.id=$1
          AND NOT EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=c.id AND h.released_at IS NULL)
          AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=c.id AND s.superseded_by IS NULL
            AND s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
    ) AS active`, [customerId]);
    return Boolean(result.rows[0]?.active);
}

async function assertSeatAvailable(client, resellerId, customerId = null) {
    const lock = await client.query('SELECT id FROM resellers WHERE id=$1 FOR UPDATE', [resellerId]);
    if (!lock.rowCount) throw new Error('Reseller not found.');
    const subscription = await resellerEntitlement(resellerId, client);
    if (!subscription.active) throw new Error('Your reseller subscription is not active. Renew it before activating customers.');
    const alreadyActive = customerId ? await customerActive(customerId, client) : false;
    const used = await seatUsage(resellerId, client);
    const limit = Number(subscription.row.seat_limit || 0);
    if (!alreadyActive && used >= limit) {
        throw new Error(`Your ${subscription.row.tier_name} tier is full (${used}/${limit} active customer entitlements). Upgrade before activating another customer.`);
    }
    return { entitlement: subscription.row, used, alreadyActive };
}

async function estateCustomerIds(resellerId, client = null) {
    const db = client || { query };
    const result = await db.query(`SELECT DISTINCT c.id FROM customers c LEFT JOIN resellers r ON r.id=$1
        WHERE c.reseller_id=$1 OR c.id=r.own_customer_id ORDER BY c.id`, [resellerId]);
    return result.rows.map(row => row.id);
}

async function reconcileIds(ids) {
    const results = [];
    for (const customerId of ids) {
        try { await provisioning.reconcileCustomer(customerId); results.push({ customerId, ok: true }); }
        catch (error) { results.push({ customerId, ok: false, error: error.message }); }
    }
    return results;
}

async function suspendEstate(resellerId, reason = 'Reseller subscription is not active') {
    const changed = [];
    const ids = await transaction(async client => {
        const customerIds = await estateCustomerIds(resellerId, client);
        for (const customerId of customerIds) {
            const before = await client.query(`SELECT 1 FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND source_key=$3 AND released_at IS NULL`, [customerId, ESTATE_HOLD, resellerId]);
            if (!before.rowCount) {
                await accessHolds.addHold({ customerId, type: ESTATE_HOLD, sourceKey: resellerId, reason, metadata: { resellerId } }, client);
                changed.push(customerId);
            }
        }
        const status = await client.query(`UPDATE resellers SET estate_suspended_at=COALESCE(estate_suspended_at,NOW()),estate_suspend_reason=$2
            WHERE id=$1 AND (estate_suspended_at IS NULL OR estate_suspend_reason IS DISTINCT FROM $2) RETURNING id`, [resellerId, String(reason).slice(0,500)]);
        if (changed.length || status.rowCount) await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('reseller.estate.suspend','reseller',$1,$2::jsonb)`, [resellerId, JSON.stringify({ reason, customers: changed.length })]);
        return customerIds;
    });
    return { customers: ids.length, changed: changed.length, reconciliation: await reconcileIds(changed) };
}

async function restoreEstate(resellerId) {
    const changed = [];
    const ids = await transaction(async client => {
        const customerIds = await estateCustomerIds(resellerId, client);
        for (const customerId of customerIds) {
            const released = await accessHolds.releaseHold({ customerId, type: ESTATE_HOLD, sourceKey: resellerId }, client);
            if (released) changed.push(customerId);
        }
        const status = await client.query(`UPDATE resellers SET estate_suspended_at=NULL,estate_suspend_reason=NULL
            WHERE id=$1 AND (estate_suspended_at IS NOT NULL OR estate_suspend_reason IS NOT NULL) RETURNING id`, [resellerId]);
        if (changed.length || status.rowCount) await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('reseller.estate.restore','reseller',$1,$2::jsonb)`, [resellerId, JSON.stringify({ customers: changed.length })]);
        return customerIds;
    });
    return { customers: ids.length, changed: changed.length, reconciliation: await reconcileIds(changed) };
}

async function reconcileEstate(resellerId) {
    const subscription = await resellerEntitlement(resellerId);
    if (subscription.active) return restoreEstate(resellerId);
    const reason = subscription.row
        ? `Reseller subscription ${subscription.row.status}; paid access ended ${new Date(subscription.row.current_period_end).toISOString()}`
        : 'No active reseller subscription';
    return suspendEstate(resellerId, reason);
}

async function reconcileAllEstates() {
    const result = await query('SELECT id FROM resellers ORDER BY id');
    const summary = { total: result.rowCount, active: 0, suspended: 0, changed: 0, failed: 0 };
    for (const row of result.rows) {
        try {
            const subscription = await resellerEntitlement(row.id);
            const outcome = await reconcileEstate(row.id);
            summary.changed += Number(outcome.changed || 0);
            if (subscription.active) summary.active += 1; else summary.suspended += 1;
        } catch (error) { summary.failed += 1; console.error(`Reseller estate reconcile failed for ${row.id}:`, error.message); }
    }
    return summary;
}

async function planForTier(client, tierId, planCode, owner) {
    const ruleCount = await client.query('SELECT COUNT(*)::int n FROM reseller_tier_plan_rules WHERE tier_id=$1 AND active=TRUE', [tierId]);
    const hasRules = Number(ruleCount.rows[0]?.n || 0) > 0;
    const result = await client.query(`
        SELECT p.* FROM plans p
        LEFT JOIN reseller_tier_plan_rules r ON r.tier_id=$1 AND r.plan_id=p.id AND r.active=TRUE
        WHERE p.code=$2 AND p.active=TRUE AND p.audience IN ('reseller','both')
          AND p.billing_interval<>'trial'
          AND (NOT $3::boolean OR (r.plan_id IS NOT NULL AND CASE WHEN $4::boolean THEN r.allow_owner ELSE r.allow_customer END))
        LIMIT 1 FOR SHARE OF p
    `, [tierId, String(planCode || '').trim(), hasRules, Boolean(owner)]);
    if (!result.rowCount) throw new Error('This customer plan is not available on your reseller tier.');
    return result.rows[0];
}

async function createOrRenewCustomer({ resellerId, customerId = null, username = null, planCode, amount = 0, currency = null, paymentMethod = 'Other', note = '', actorUserId = null, owner = false }) {
    const cfg = await resellerSettings.forReseller(resellerId);
    const cleanUsername = core.cleanText(username, 40);
    if (!customerId && !owner && !/^[A-Za-z0-9._-]{3,40}$/.test(cleanUsername)) throw new Error('Enter a valid Jellyfin username.');
    if (owner && !cfg.ownerAccountAllowed) throw new Error('Reseller-owned Jellyfin accounts are disabled by the administrator.');
    const amountMinor = owner ? 0 : core.moneyMinor(amount || 0);
    const requestedCurrency = currency ? core.cleanCurrency(currency) : cfg.ledgerCurrency;
    if (requestedCurrency !== cfg.ledgerCurrency) throw new Error(`Sales for this reseller must be recorded in ${cfg.ledgerCurrency}.`);
    const method = owner ? 'internal' : resellerSettings.validatePaymentMethod(cfg, paymentMethod);
    const cleanNote = core.cleanText(note, 500);

    const saved = await transaction(async client => {
        const subscription = await resellerEntitlement(resellerId, client);
        if (!subscription.active) throw new Error('Your reseller subscription is not active.');
        const plan = await planForTier(client, subscription.row.tier_id, planCode, owner);
        let customer;
        if (customerId) {
            const found = await client.query('SELECT * FROM customers WHERE id=$1 AND reseller_id=$2 FOR UPDATE', [customerId, resellerId]);
            if (!found.rowCount) throw new Error('Customer not found.');
            customer = found.rows[0];
        } else if (owner) {
            const reseller = await client.query(`SELECT r.*,u.username,u.email FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE r.id=$1 FOR UPDATE OF r`, [resellerId]);
            if (!reseller.rowCount) throw new Error('Reseller not found.');
            if (reseller.rows[0].own_customer_id) {
                const existingOwner = await client.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE', [reseller.rows[0].own_customer_id]);
                customer = existingOwner.rows[0];
            } else {
                const createdOwner = await client.query(`INSERT INTO customers(user_id,reseller_id,display_name,email,is_reseller_owner)
                    VALUES($1,$2,$3,$4,TRUE) RETURNING *`, [reseller.rows[0].user_id,resellerId,reseller.rows[0].username,reseller.rows[0].email]);
                customer = createdOwner.rows[0];
                await client.query('UPDATE resellers SET own_customer_id=$2 WHERE id=$1', [resellerId,customer.id]);
            }
        } else {
            customer = (await client.query(`INSERT INTO customers(reseller_id,display_name,note) VALUES($1,$2,$3) RETURNING *`, [resellerId,cleanUsername,cleanNote])).rows[0];
        }

        const seats = await assertSeatAvailable(client, resellerId, customer.id);
        const existing = await client.query(`SELECT * FROM subscriptions WHERE customer_id=$1 AND superseded_by IS NULL
            AND status IN ('active','trialing','past_due','paused') AND current_period_end>NOW()
            ORDER BY current_period_end DESC,created_at DESC LIMIT 1 FOR UPDATE`, [customer.id]);
        if (existing.rowCount) subscriptionState.assertSafeSourceRewrite(existing.rows[0], 'reseller_sale');
        const now = new Date();
        const base = existing.rowCount && new Date(existing.rows[0].current_period_end)>now ? new Date(existing.rows[0].current_period_end) : now;
        const end = new Date(base.getTime() + Number(plan.duration_days || 30) * 86400000);
        const createdSub = await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'active','reseller_sale',$3,$4) RETURNING *`, [customer.id,plan.id,now,end]);
        if (existing.rowCount) {
            await client.query(`UPDATE subscriptions SET status='cancelled',superseded_by=$2,replaced_at=NOW(),replacement_reason='reseller_renewal',updated_at=NOW() WHERE id=$1`, [existing.rows[0].id,createdSub.rows[0].id]);
        }
        await accessHolds.releaseHold({ customerId: customer.id, type: MANUAL_HOLD, sourceKey: resellerId, actorUserId }, client);
        const saleType = owner ? 'owner_access' : (amountMinor === 0 ? 'complimentary' : 'sale');
        const sale = await client.query(`INSERT INTO reseller_sales(
            reseller_id,customer_id,plan_id,amount_minor,currency,payment_method,service_starts_at,service_ends_at,note,sale_type,actor_user_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [resellerId,customer.id,plan.id,amountMinor,cfg.ledgerCurrency,method,base,end,owner?'Reseller own access':cleanNote,saleType,actorUserId]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'reseller.customer.sale','customer',$2,$3::jsonb)`, [actorUserId,customer.id,JSON.stringify({ resellerId,planCode:plan.code,amountMinor,currency:cfg.ledgerCurrency,paymentMethod:method,serviceEndsAt:end.toISOString(),seatLimit:seats.entitlement.seat_limit,saleType })]);
        return { customer, plan, subscription: createdSub.rows[0], sale: sale.rows[0], seats };
    });
    const reconcile = await provisioning.reconcileCustomer(saved.customer.id);
    return { ...saved, reconcile };
}

async function setCustomerManualSuspended({ resellerId, customerId, suspended, actorUserId = null }) {
    await transaction(async client => {
        const found = await client.query('SELECT id FROM customers WHERE id=$1 AND reseller_id=$2 FOR UPDATE', [customerId,resellerId]);
        if (!found.rowCount) throw new Error('Customer not found.');
        if (suspended) {
            await accessHolds.addHold({ customerId, type: MANUAL_HOLD, sourceKey: resellerId, reason: 'Suspended by reseller', actorUserId, metadata: { resellerId } }, client);
        } else {
            await assertSeatAvailable(client, resellerId, customerId);
            await accessHolds.releaseHold({ customerId, type: MANUAL_HOLD, sourceKey: resellerId, actorUserId }, client);
        }
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,$2,'customer',$3,$4::jsonb)`, [actorUserId,suspended?'reseller.customer.suspend':'reseller.customer.resume',customerId,JSON.stringify({resellerId})]);
    });
    return provisioning.reconcileCustomer(customerId);
}

async function salesAnalytics(resellerId, { from, to }) {
    const start = new Date(from), end = new Date(to);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end<start) throw new Error('Invalid reporting period.');
    const revenueExpr = `CASE WHEN rs.sale_type='refund' THEN -rs.amount_minor WHEN rs.sale_type IN ('sale','adjustment') THEN rs.amount_minor ELSE 0 END`;
    const [totals,daily,newCustomers,playback,topCustomers] = await Promise.all([
        query(`SELECT currency,SUM(${revenueExpr})::bigint amount_minor,COUNT(*) FILTER(WHERE rs.sale_type='sale')::int sales FROM reseller_sales rs WHERE reseller_id=$1 AND created_at>=$2 AND created_at<$3 AND voided_at IS NULL GROUP BY currency ORDER BY currency`,[resellerId,start,end]),
        query(`SELECT date_trunc('day',created_at)::date day,currency,SUM(${revenueExpr})::bigint amount_minor FROM reseller_sales rs WHERE reseller_id=$1 AND created_at>=$2 AND created_at<$3 AND voided_at IS NULL GROUP BY 1,2 ORDER BY 1,2`,[resellerId,start,end]),
        query(`SELECT COUNT(*)::int n FROM customers WHERE reseller_id=$1 AND is_reseller_owner=FALSE AND created_at>=$2 AND created_at<$3`,[resellerId,start,end]),
        query(`SELECT COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM(COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at)))),0)::bigint seconds,COUNT(*)::int sessions,COUNT(DISTINCT ph.customer_id)::int viewers FROM playback_history ph JOIN customers c ON c.id=ph.customer_id WHERE c.reseller_id=$1 AND ph.started_at>=$2 AND ph.started_at<$3`,[resellerId,start,end]),
        query(`SELECT c.id,c.display_name,rs.currency,COALESCE(SUM(${revenueExpr}),0)::bigint revenue_minor,COUNT(rs.id) FILTER(WHERE rs.sale_type='sale')::int sales FROM customers c LEFT JOIN reseller_sales rs ON rs.customer_id=c.id AND rs.created_at>=$2 AND rs.created_at<$3 AND rs.voided_at IS NULL WHERE c.reseller_id=$1 AND c.is_reseller_owner=FALSE GROUP BY c.id,rs.currency ORDER BY revenue_minor DESC LIMIT 20`,[resellerId,start,end])
    ]);
    return { totals: totals.rows,daily: daily.rows,newCustomers:Number(newCustomers.rows[0]?.n||0),playback:playback.rows[0],topCustomers:topCustomers.rows };
}

async function applyGrace(saved) {
    if (!saved?.id) return saved;
    const row = await currentSubscription(saved.reseller_id);
    if (!row) return saved;
    if (row.status === 'past_due' && Number(row.grace_days || 0) > 0) {
        await query(`UPDATE reseller_subscriptions SET grace_until=COALESCE(grace_until,NOW()+($2::int*INTERVAL '1 day')),updated_at=NOW() WHERE id=$1`, [row.id,Number(row.grace_days)]);
    } else if (row.status === 'active') {
        await query('UPDATE reseller_subscriptions SET grace_until=NULL WHERE id=$1', [row.id]);
    }
    await reconcileEstate(saved.reseller_id);
    return currentSubscription(saved.reseller_id);
}

async function setProviderSubscription(input) { return applyGrace(await core.setProviderSubscription(input)); }
async function updateKnownProviderSubscription(input) { return applyGrace(await core.updateKnownProviderSubscription(input)); }
async function createManualTierSubscription(input) { const row=await core.createManualTierSubscription(input); await reconcileEstate(input.resellerId); return currentSubscription(input.resellerId)||row; }

module.exports = {
    ...core,
    currentSubscription,
    resellerEntitlement,
    seatUsage,
    assertSeatAvailable,
    suspendEstate,
    restoreEstate,
    reconcileEstate,
    reconcileAllEstates,
    createOrRenewCustomer,
    setCustomerManualSuspended,
    salesAnalytics,
    setProviderSubscription,
    updateKnownProviderSubscription,
    createManualTierSubscription,
    statusIsEntitled: entitled
};
