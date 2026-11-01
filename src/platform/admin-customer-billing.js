'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const { rateLimit } = require('express-rate-limit');
const manualPaymentLedger = require('../payments/manual-payment-ledger');
const operatorRefund = require('../payments/operator-refund');

const { METHOD_LABELS, CURRENCIES } = manualPaymentLedger;
const writeLimit = routeRateLimit.middleware({ scope: 'admin-customer-billing-write', max: 30, windowSeconds: 60, reason: 'admin_customer_billing_write' });

// CodeQL recognises express-rate-limit but not the in-house limiter, so the money-moving refund
// route uses it directly (per client, one minute window).
const refundLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: 'Too many refund records. Please try again shortly.'
});

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

    // A refund made outside the app (provider dashboard or cash). Records it and, for a full
    // refund, ends the plan the way a provider refund would. Needs a reason and typed confirmation.
    router.post('/admin/users/:customerId/record-refund', refundLimit, writeLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const redirect = (kind, text) => res.redirect(path(req.params.customerId) + '&' + kind + '=' + encodeURIComponent(text) + '#customer-payments');
        try {
            const full = req.body.full === '1';
            if (full && String(req.body.confirm || '').trim() !== 'REFUND') return redirect('error', 'Type REFUND to confirm that this ends the plan.');
            const result = await operatorRefund.record({
                customerId: req.params.customerId,
                subscriptionId: req.body.subscriptionId,
                submissionId: req.body.submissionId,
                amount: req.body.amount,
                full,
                reason: req.body.reason,
                actorUserId: req.session.authUserId
            });
            return redirect('message', full ? 'Refund recorded and the plan ended.' : 'Partial refund recorded. The plan was not changed.');
        } catch (error) {
            return redirect('error', `Could not record the refund. ${String(error.message || 'Try again.').slice(0, 300)}`);
        }
    });

    return router;
}

module.exports = { createAdminCustomerBillingRouter, manualPayments, METHOD_LABELS, CURRENCIES };
