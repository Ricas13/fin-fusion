'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const manualPaymentLedger = require('../payments/manual-payment-ledger');

const { METHOD_LABELS, CURRENCIES } = manualPaymentLedger;
const writeLimit = routeRateLimit.middleware({ scope: 'admin-customer-billing-write', max: 30, windowSeconds: 60, reason: 'admin_customer_billing_write' });

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function path(customerId) {
    return `/admin/users/${encodeURIComponent(customerId)}?tab=billing`;
}
// Manual entries remain a separate operator-entered ledger. Stripe, PayPal
// and Plisio provider transactions are projected from provider-financial-state
// by the customer/payment read models; this route owns manual entries only.
async function manualPayments(customerId) {
    return manualPaymentLedger.list(customerId);
}

function createAdminCustomerBillingRouter() {
    const router = express.Router();
    router.use('/admin/users', gate);

    router.post('/admin/users/:customerId/manual-payment', writeLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            await manualPaymentLedger.record({
                customerId: req.params.customerId,
                amount: req.body.amount,
                currency: req.body.currency,
                method: req.body.method,
                note: req.body.note,
                actorUserId: req.session.authUserId
            });
            return res.redirect(path(req.params.customerId) + '&message=' + encodeURIComponent('Manual payment recorded.'));
        } catch (error) {
            return res.redirect(path(req.params.customerId) + '&error=' + encodeURIComponent(`Could not record payment. ${String(error.message || 'Try again.').slice(0, 300)}`));
        }
    });

    return router;
}

module.exports = { createAdminCustomerBillingRouter, manualPayments, METHOD_LABELS, CURRENCIES };
