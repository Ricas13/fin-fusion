'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');

const METHOD_LABELS = { cash: 'Cash', bank_transfer: 'Bank transfer', crypto: 'Crypto', other: 'Other' };
const CURRENCIES = ['GBP', 'USD', 'EUR'];

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function path(customerId) {
    return `/admin/users/${encodeURIComponent(customerId)}?tab=billing`;
}
function cleanAmountMinor(raw) {
    const value = Number.parseFloat(String(raw || '').replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) throw new Error('Enter an amount greater than zero.');
    const minor = Math.round(value * 100);
    if (minor > 100000000) throw new Error('Amount is too large.');
    return minor;
}
function cleanCurrency(raw) {
    const value = String(raw || '').trim().toUpperCase();
    if (!CURRENCIES.includes(value)) throw new Error('Choose a valid currency.');
    return value;
}
function cleanMethod(raw) {
    const value = String(raw || '').trim();
    if (!Object.prototype.hasOwnProperty.call(METHOD_LABELS, value)) throw new Error('Choose a valid payment method.');
    return value;
}

// Manual entries the admin recorded here, most recent first. Real provider
// payments (Stripe/PayPal) are shown from the caller's already-loaded
// `detail.subscriptions` -- this module only owns the manual ledger.
async function manualPayments(customerId) {
    const result = await query(`
        SELECT mpe.id,mpe.amount_minor,mpe.currency,mpe.method,mpe.note,mpe.created_at,
               COALESCE(u.username,'—') AS recorded_by_username
        FROM manual_payment_events mpe
        LEFT JOIN app_users u ON u.id=mpe.recorded_by
        WHERE mpe.customer_id=$1
        ORDER BY mpe.created_at DESC
        LIMIT 100
    `, [customerId]);
    return result.rows;
}

function createAdminCustomerBillingRouter() {
    const router = express.Router();
    router.use('/admin/users', gate);

    router.post('/admin/users/:customerId/manual-payment', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const amountMinor = cleanAmountMinor(req.body.amount);
            const currency = cleanCurrency(req.body.currency);
            const method = cleanMethod(req.body.method);
            const note = String(req.body.note || '').trim().slice(0, 500);
            const customer = await query('SELECT id FROM customers WHERE id=$1', [req.params.customerId]);
            if (!customer.rowCount) throw new Error('Customer not found.');
            await query(`
                INSERT INTO manual_payment_events(customer_id,amount_minor,currency,method,note,recorded_by)
                VALUES($1,$2,$3,$4,$5,$6)
            `, [req.params.customerId, amountMinor, currency, method, note, req.session.authUserId]);
            await query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'admin.customer.manual_payment.recorded','customer',$2,$3::jsonb)
            `, [req.session.authUserId, req.params.customerId, JSON.stringify({ amountMinor, currency, method })]);
            return res.redirect(path(req.params.customerId) + '&message=' + encodeURIComponent('Manual payment recorded.'));
        } catch (error) {
            return res.redirect(path(req.params.customerId) + '&error=' + encodeURIComponent(`Could not record payment. ${String(error.message || 'Try again.').slice(0, 300)}`));
        }
    });

    return router;
}

module.exports = { createAdminCustomerBillingRouter, manualPayments, METHOD_LABELS, CURRENCIES };
