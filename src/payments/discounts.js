'use strict';

const { query } = require('../db');

function normalizeCode(raw) {
    return String(raw || '').trim().toUpperCase();
}

async function findActiveCode(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    const result = await query(`
        SELECT * FROM discount_codes
        WHERE code=$1 AND active=TRUE
          AND (starts_at IS NULL OR starts_at<=NOW())
          AND (expires_at IS NULL OR expires_at>NOW())
        LIMIT 1
    `, [normalized]);
    return result.rows[0] || null;
}

async function validateForCheckout({ code, planId, planCode, customerId }) {
    if (!code) return null;
    const discount = await findActiveCode(code);
    if (!discount) throw new Error('That discount code is not valid or has expired');

    if (Array.isArray(discount.plan_codes) && discount.plan_codes.length && !discount.plan_codes.includes(planCode)) {
        throw new Error('That discount code does not apply to this plan');
    }
    if (discount.max_redemptions !== null && discount.redemption_count >= discount.max_redemptions) {
        throw new Error('That discount code has reached its redemption limit');
    }
    if (customerId) {
        const used = await query(
            'SELECT COUNT(*)::int AS n FROM discount_redemptions WHERE discount_code_id=$1 AND customer_id=$2',
            [discount.id, customerId]
        );
        if (used.rows[0].n >= discount.per_customer_limit) {
            throw new Error('You have already used that discount code');
        }
    }
    return discount;
}

function computeDiscountedMinor(baseMinor, discount) {
    const base = Number(baseMinor) || 0;
    if (!discount) return base;
    if (discount.discount_type === 'percent') {
        return Math.max(0, Math.round(base * (100 - discount.percent_off) / 100));
    }
    return Math.max(0, base - Number(discount.fixed_off_minor || 0));
}

// Runs inside the same transaction that activates a paid subscription. By design this
// NEVER throws for a limit violation -- by the time this runs, a payment provider has
// already accepted the customer's money, so a bookkeeping limit being exceeded (lost a
// race against a concurrent checkout, or a webhook retry) must not roll back or block
// the subscription/Jellyfin access the customer already paid for. It only refuses to
// double-count. Idempotent per subscription via a unique index + ON CONFLICT DO NOTHING,
// so a retried webhook/activation for the same subscription is a safe no-op.
async function redeemForSubscriptionTx(client, { discountCodeId, customerId, subscriptionId, amountAppliedMinor = 0 }) {
    if (!discountCodeId) return { redeemed: false, reason: 'no_code' };

    // Lock the discount_codes row so concurrent redemption attempts for the SAME code
    // serialize here, closing the race window validateForCheckout() (a pre-payment,
    // non-locking check) cannot close on its own.
    const discount = await client.query('SELECT * FROM discount_codes WHERE id=$1 FOR UPDATE', [discountCodeId]);
    if (!discount.rowCount) {
        console.error(`Discount code ${discountCodeId} was removed before redemption could be recorded; granting access anyway.`);
        return { redeemed: false, reason: 'code_missing' };
    }
    const row = discount.rows[0];

    if (row.max_redemptions !== null && row.redemption_count >= row.max_redemptions) {
        console.error(`Discount ${row.code} exceeded its redemption limit at activation time; granting access anyway.`);
        return { redeemed: false, reason: 'max_redemptions' };
    }
    if (customerId) {
        const used = await client.query(
            'SELECT COUNT(*)::int AS n FROM discount_redemptions WHERE discount_code_id=$1 AND customer_id=$2',
            [discountCodeId, customerId]
        );
        if (used.rows[0].n >= row.per_customer_limit) {
            console.error(`Discount ${row.code} exceeded its per-customer limit for customer ${customerId} at activation time; granting access anyway.`);
            return { redeemed: false, reason: 'per_customer_limit' };
        }
    }

    // INSERT first, under the discount_codes lock: the unique index on subscription_id
    // is the actual source of truth for "is this a new redemption." A retried activation
    // for the same subscription hits ON CONFLICT and inserts nothing, so the counter below
    // only ever moves for a row that was genuinely just inserted -- fixing the double-count
    // a separate up-front existence check would otherwise allow (two concurrent activations
    // for the same subscription can both pass a pre-lock check before either holds the lock).
    const inserted = await client.query(`
        INSERT INTO discount_redemptions(discount_code_id,customer_id,subscription_id,amount_applied_minor)
        VALUES($1,$2,$3,$4)
        ON CONFLICT (subscription_id) WHERE subscription_id IS NOT NULL DO NOTHING
        RETURNING id
    `, [discountCodeId, customerId, subscriptionId || null, amountAppliedMinor]);

    if (!inserted.rowCount) return { redeemed: true, alreadyRecorded: true };

    await client.query('UPDATE discount_codes SET redemption_count=redemption_count+1,updated_at=NOW() WHERE id=$1', [discountCodeId]);
    return { redeemed: true };
}

module.exports = {
    normalizeCode,
    findActiveCode,
    validateForCheckout,
    computeDiscountedMinor,
    redeemForSubscriptionTx
};
