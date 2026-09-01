'use strict';

const { query, transaction } = require('../db');

function normalizeCode(raw) { return String(raw || '').trim().toUpperCase(); }
function normalizeCurrency(raw) { return String(raw || '').trim().toUpperCase(); }
function redemptionDivergence(message) {
    const error = new Error(message);
    error.code='DISCOUNT_REDEMPTION_DIVERGENCE';
    return error;
}
function discountConflict(message) {
    const error = new Error(message);
    error.code = 'DISCOUNT_SETTLEMENT_RESERVATION_MISMATCH';
    return error;
}
function assertDiscountCurrency(discount, currency) {
    const wanted = normalizeCurrency(currency), fixed = normalizeCurrency(discount?.currency);
    if (discount?.discount_type === 'fixed' && fixed && wanted && fixed !== wanted) {
        const error = new Error("That discount code's currency does not match this plan");
        error.code = 'DISCOUNT_CURRENCY_MISMATCH';
        error.expose = true;
        throw error;
    }
    return discount;
}
async function findActiveCode(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    const result = await query(`SELECT * FROM discount_codes WHERE code=$1 AND active=TRUE AND (starts_at IS NULL OR starts_at<=NOW()) AND (expires_at IS NULL OR expires_at>NOW()) LIMIT 1`, [normalized]);
    return result.rows[0] || null;
}
async function validateForCheckout({ code, planId, planCode, customerId, currency = null }) {
    if (!code) return null;
    const discount = await findActiveCode(code);
    if (!discount) throw new Error('That discount code is not valid or has expired');
    if (Array.isArray(discount.plan_codes) && discount.plan_codes.length && !discount.plan_codes.includes(planCode)) throw new Error('That discount code does not apply to this plan');
    assertDiscountCurrency(discount, currency);
    if (discount.max_redemptions !== null && discount.redemption_count >= discount.max_redemptions) throw new Error('That discount code has reached its redemption limit');
    if (customerId) {
        const used = await query('SELECT COUNT(*)::int AS n FROM discount_redemptions WHERE discount_code_id=$1 AND customer_id=$2', [discount.id, customerId]);
        if (used.rows[0].n >= discount.per_customer_limit) throw new Error('You have already used that discount code');
    }
    return discount;
}
function computeDiscountedMinor(baseMinor, discount) {
    const base = Number(baseMinor) || 0;
    if (!discount) return base;
    if (discount.discount_type === 'percent') return Math.max(0, Math.round(base * (100 - discount.percent_off) / 100));
    return Math.max(0, base - Number(discount.fixed_off_minor || 0));
}

async function reserveForIntent({ code, planCode, customerId, checkoutIntentId, baseMinor = 0, currency = null, ttlMinutes = 30 }) {
    if (!code) return null;
    return transaction(async client => {
        await client.query(`UPDATE discount_checkout_reservations SET state='expired',updated_at=NOW() WHERE state='reserved' AND expires_at<=NOW()`);
        const intentResult = await client.query(`SELECT id,customer_id,state,expires_at,commercial_snapshot FROM billing_checkout_intents WHERE id=$1 FOR SHARE`, [checkoutIntentId]);
        if (!intentResult.rowCount) throw new Error('Checkout intent was not found for this discount reservation');
        const intent = intentResult.rows[0];
        if (String(intent.customer_id) !== String(customerId)) throw new Error('Discount reservation customer does not match the checkout intent');
        if (intent.state !== 'open') throw new Error('Discounts can only be reserved for an open checkout intent');
        const parentExpiry = new Date(intent.expires_at);
        if (Number.isNaN(parentExpiry.getTime()) || parentExpiry <= new Date()) throw new Error('Checkout intent has already expired');
        const contractCurrency = normalizeCurrency(intent.commercial_snapshot?.currency), requestedCurrency = normalizeCurrency(currency);
        if (contractCurrency && requestedCurrency && contractCurrency !== requestedCurrency) throw discountConflict('Checkout currency changed before the discount reservation was created.');

        const found = await client.query(`SELECT * FROM discount_codes WHERE code=$1 AND active=TRUE AND (starts_at IS NULL OR starts_at<=NOW()) AND (expires_at IS NULL OR expires_at>NOW()) FOR UPDATE`, [normalizeCode(code)]);
        if (!found.rowCount) throw new Error('That discount code is not valid or has expired');
        const d = found.rows[0];
        if (Array.isArray(d.plan_codes) && d.plan_codes.length && !d.plan_codes.includes(planCode)) throw new Error('That discount code does not apply to this plan');
        assertDiscountCurrency(d, contractCurrency || requestedCurrency);
        const reserved = await client.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE customer_id=$2)::int customer_total FROM discount_checkout_reservations WHERE discount_code_id=$1 AND state='reserved' AND expires_at>NOW()`, [d.id, customerId]);
        const totals = reserved.rows[0];
        if (d.max_redemptions !== null && Number(d.redemption_count || 0) + Number(totals.total || 0) >= Number(d.max_redemptions)) throw new Error('That discount code has reached its redemption limit');
        const used = await client.query('SELECT COUNT(*)::int n FROM discount_redemptions WHERE discount_code_id=$1 AND customer_id=$2', [d.id, customerId]);
        if (Number(used.rows[0].n || 0) + Number(totals.customer_total || 0) >= Number(d.per_customer_limit || 1)) throw new Error('You have already used or reserved that discount code');
        const discounted = computeDiscountedMinor(baseMinor, d), applied = Math.max(0, Number(baseMinor || 0) - discounted);
        const requestedExpiry = new Date(Date.now() + Math.max(5, Math.min(180, Number(ttlMinutes) || 30)) * 60000);
        // Reservation coverage is an invariant: a still-valid checkout may never
        // outlive the limited-code capacity it froze into commercial_snapshot.
        // Static contract token kept explicit: Math.max(requestedExpiry.getTime(),parentExpiry.getTime())
        const expiresAt = new Date(Math.max(requestedExpiry.getTime(),parentExpiry.getTime()));
        const row = await client.query(`INSERT INTO discount_checkout_reservations(discount_code_id,customer_id,checkout_intent_id,amount_applied_minor,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *`, [d.id, customerId, checkoutIntentId, applied, expiresAt]);
        return { discount: d, reservation: row.rows[0], discountedMinor: discounted };
    });
}
async function releaseIntentReservation(checkoutIntentId, state = 'released') {
    if (!checkoutIntentId) return 0;
    const normalized = state === 'consumed' ? 'consumed' : 'released';
    const r = await query(`UPDATE discount_checkout_reservations SET state=$2,consumed_at=CASE WHEN $2='consumed' THEN NOW() ELSE consumed_at END,released_at=CASE WHEN $2='released' THEN NOW() ELSE released_at END,updated_at=NOW() WHERE checkout_intent_id=$1 AND state='reserved' RETURNING id`, [checkoutIntentId, normalized]);
    return r.rowCount;
}

async function frozenReservationForSubscription(client, { discountCodeId, customerId, subscriptionId }) {
    if (!subscriptionId || !customerId || !discountCodeId) return null;
    const sub = (await client.query(`SELECT commercial_snapshot FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR SHARE`, [subscriptionId, customerId])).rows[0];
    if (!sub) return null;
    const snapshot = sub.commercial_snapshot && typeof sub.commercial_snapshot === 'object' ? sub.commercial_snapshot : {};
    const reservationId = String(snapshot.discountReservationId || '').trim();
    const checkoutIntentId = String(snapshot.checkoutIntentId || '').trim();
    if (!reservationId && !checkoutIntentId) return null;

    const params = [customerId, discountCodeId];
    let where = 'customer_id=$1 AND discount_code_id=$2';
    if (reservationId) { params.push(reservationId); where += ` AND id=$${params.length}`; }
    if (checkoutIntentId) { params.push(checkoutIntentId); where += ` AND checkout_intent_id=$${params.length}`; }
    const reservation = (await client.query(`SELECT * FROM discount_checkout_reservations WHERE ${where} FOR UPDATE`, params)).rows[0] || null;
    if (reservationId && !reservation) throw discountConflict('Checkout commercial snapshot references a discount reservation that no longer matches this subscription.');
    return reservation;
}

async function recordRedemption(client, { discountCodeId, customerId, subscriptionId, amountAppliedMinor }) {
    const existing = (await client.query(`SELECT * FROM discount_redemptions WHERE subscription_id=$1 LIMIT 1`, [subscriptionId])).rows[0];
    if (existing) {
        if (String(existing.discount_code_id) !== String(discountCodeId) || String(existing.customer_id) !== String(customerId)) {
            throw discountConflict('Subscription already has a different discount redemption identity.');
        }
        return { redeemed: true, alreadyRecorded: true, redemption: existing };
    }
    const inserted = await client.query(`INSERT INTO discount_redemptions(discount_code_id,customer_id,subscription_id,amount_applied_minor) VALUES($1,$2,$3,$4) ON CONFLICT (subscription_id) WHERE subscription_id IS NOT NULL DO NOTHING RETURNING *`, [discountCodeId, customerId, subscriptionId || null, amountAppliedMinor]);
    if (!inserted.rowCount) {
        const raced = (await client.query(`SELECT * FROM discount_redemptions WHERE subscription_id=$1 LIMIT 1`, [subscriptionId])).rows[0];
        if (!raced || String(raced.discount_code_id) !== String(discountCodeId) || String(raced.customer_id) !== String(customerId)) throw discountConflict('Concurrent discount redemption does not match this subscription.');
        return { redeemed: true, alreadyRecorded: true, redemption: raced };
    }
    await client.query('UPDATE discount_codes SET redemption_count=redemption_count+1,updated_at=NOW() WHERE id=$1', [discountCodeId]);
    return { redeemed: true, redemption: inserted.rows[0] };
}

async function redeemForSubscriptionTx(client, { discountCodeId, customerId, subscriptionId, amountAppliedMinor = 0 }) {
    if (!discountCodeId) return { redeemed: false, reason: 'no_code' };
    const discount = await client.query('SELECT * FROM discount_codes WHERE id=$1 FOR UPDATE', [discountCodeId]);
    if (!discount.rowCount) throw redemptionDivergence(`Discount code ${discountCodeId} was removed before its paid checkout could be accounted for.`);
    const row = discount.rows[0];
    const frozen = await frozenReservationForSubscription(client, { discountCodeId, customerId, subscriptionId });
    if (frozen) {
        const result = await recordRedemption(client, {
            discountCodeId,
            customerId,
            subscriptionId,
            amountAppliedMinor: Number(frozen.amount_applied_minor || 0)
        });
        return { ...result, frozenReservation: true, reservationId: frozen.id };
    }

    if (row.max_redemptions !== null && row.redemption_count >= row.max_redemptions) throw redemptionDivergence(`Discount ${row.code} no longer has redemption capacity for this paid checkout.`);
    if (customerId) {
        const used = await client.query('SELECT COUNT(*)::int AS n FROM discount_redemptions WHERE discount_code_id=$1 AND customer_id=$2', [discountCodeId, customerId]);
        if (used.rows[0].n >= row.per_customer_limit) throw redemptionDivergence(`Discount ${row.code} can no longer be attributed to this customer without exceeding its per-customer limit.`);
    }
    return recordRedemption(client, { discountCodeId, customerId, subscriptionId, amountAppliedMinor });
}

module.exports = { normalizeCode, normalizeCurrency, assertDiscountCurrency, findActiveCode, validateForCheckout, computeDiscountedMinor, reserveForIntent, releaseIntentReservation, redeemForSubscriptionTx, frozenReservationForSubscription, redemptionDivergence };
