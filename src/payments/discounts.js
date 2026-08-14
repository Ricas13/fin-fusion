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

async function redeemForSubscriptionTx(client, { discountCodeId, customerId, subscriptionId, amountAppliedMinor = 0 }) {
    const claimed = await client.query(`
        UPDATE discount_codes
        SET redemption_count=redemption_count+1, updated_at=NOW()
        WHERE id=$1 AND (max_redemptions IS NULL OR redemption_count<max_redemptions)
        RETURNING id
    `, [discountCodeId]);
    if (!claimed.rowCount) throw new Error('That discount code has reached its redemption limit');
    await client.query(`
        INSERT INTO discount_redemptions(discount_code_id,customer_id,subscription_id,amount_applied_minor)
        VALUES($1,$2,$3,$4)
    `, [discountCodeId, customerId, subscriptionId || null, amountAppliedMinor]);
}

module.exports = {
    normalizeCode,
    findActiveCode,
    validateForCheckout,
    computeDiscountedMinor,
    redeemForSubscriptionTx
};
