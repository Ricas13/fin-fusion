'use strict';

const core = require('./subscriptions-core');
const { query } = require('./db');
const state = require('./entitlements/subscription-state');

async function assertLegacyCreditSafe(customerId) {
    const existing = await query(`SELECT * FROM subscriptions
        WHERE customer_id=$1 AND superseded_by IS NULL
          AND status IN ('active','trialing','past_due','paused')
          AND current_period_end>NOW()
        ORDER BY current_period_end DESC LIMIT 1`, [customerId]);
    if (existing.rowCount) state.assertSafeSourceRewrite(existing.rows[0], 'reseller_credit');
}

async function extendWithResellerCredits(input) {
    await assertLegacyCreditSafe(input.customerId);
    return core.extendWithResellerCredits(input);
}

module.exports = { ...core, extendWithResellerCredits };
