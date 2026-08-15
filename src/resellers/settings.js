'use strict';

const { query } = require('../db');

const FALLBACK_METHODS = ['Cash','Bank transfer','PayPal','Stripe','Other'];
function cleanCurrency(value) {
    const code = String(value || 'GBP').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : 'GBP';
}

async function defaults() {
    const result = await query(`SELECT setting_value FROM platform_settings WHERE setting_key='reseller_defaults_v2'`);
    const value = result.rows[0]?.setting_value || {};
    return {
        ledgerCurrency: cleanCurrency(value.ledgerCurrency || 'GBP'),
        paymentMethods: Array.isArray(value.paymentMethods) && value.paymentMethods.length ? value.paymentMethods.map(String) : FALLBACK_METHODS,
        ownerAccountAllowed: value.ownerAccountAllowed !== false,
        defaultTierId: value.defaultTierId || null
    };
}

async function forReseller(resellerId) {
    const [base, row] = await Promise.all([
        defaults(),
        query('SELECT ledger_currency,allowed_payment_methods,owner_account_allowed FROM resellers WHERE id=$1', [resellerId])
    ]);
    if (!row.rowCount) throw new Error('Reseller not found.');
    const reseller = row.rows[0];
    return {
        ledgerCurrency: cleanCurrency(reseller.ledger_currency || base.ledgerCurrency),
        paymentMethods: Array.isArray(reseller.allowed_payment_methods) && reseller.allowed_payment_methods.length ? reseller.allowed_payment_methods : base.paymentMethods,
        ownerAccountAllowed: reseller.owner_account_allowed !== false && base.ownerAccountAllowed !== false,
        defaultTierId: base.defaultTierId
    };
}

async function eligiblePlans(tierId, { owner = false, includeTrial = false } = {}) {
    const rules = await query('SELECT COUNT(*)::int n FROM reseller_tier_plan_rules WHERE tier_id=$1 AND active=TRUE', [tierId]);
    const hasRules = Number(rules.rows[0]?.n || 0) > 0;
    const result = await query(`
        SELECT p.*
        FROM plans p
        LEFT JOIN reseller_tier_plan_rules r ON r.tier_id=$1 AND r.plan_id=p.id AND r.active=TRUE
        WHERE p.active=TRUE AND p.audience IN ('reseller','both')
          AND ($2::boolean=FALSE OR p.billing_interval='trial' OR p.billing_interval<>'trial')
          AND (NOT $3::boolean OR r.plan_id IS NOT NULL)
          AND (NOT $3::boolean OR CASE WHEN $4::boolean THEN r.allow_owner ELSE r.allow_customer END)
          AND (p.billing_interval<>'trial' OR ($5::boolean AND (NOT $3::boolean OR r.allow_trial)))
        ORDER BY p.sort_order,p.price_minor,p.name
    `, [tierId, includeTrial, hasRules, owner, includeTrial]);
    return result.rows;
}

function validatePaymentMethod(settings, value) {
    const requested = String(value || '').trim();
    const match = settings.paymentMethods.find(method => method.toLowerCase() === requested.toLowerCase());
    if (!match) throw new Error('Choose one of the payment methods configured by the administrator.');
    return match;
}

module.exports = { FALLBACK_METHODS, defaults, forReseller, eligiblePlans, validatePaymentMethod, cleanCurrency };
