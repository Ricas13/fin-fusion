'use strict';

const express = require('express');
const stripe = require('../payments/stripe');
const paypal = require('../payments/paypal');
const resellerBilling = require('../payments/reseller-billing');
const providerSettings = require('../payments/provider-settings');

function createWebhookRouter() {
    const router = express.Router();

    router.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
        try {
            await providerSettings.ensureLoaded();
            if (!stripe.enabled()) return res.status(404).end();
            const signature = req.get('stripe-signature');
            if (!signature) return res.status(400).send('Missing Stripe signature');
            // Routing is based only on unsigned metadata / an existing internal
            // subscription lookup. The selected processor still verifies Stripe's
            // signature before any state changes are made.
            if (await resellerBilling.isStripeResellerEvent(req.body)) {
                await resellerBilling.processStripeWebhook(req.body, signature);
            } else {
                await stripe.processWebhook(req.body, signature);
            }
            return res.json({ received: true });
        } catch (error) {
            console.error('Stripe webhook error:', error.message);
            return res.status(400).send('Webhook rejected');
        }
    });

    router.post('/webhooks/paypal', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
        try {
            await providerSettings.ensureLoaded();
            if (!paypal.enabled()) return res.status(404).end();
            if (await resellerBilling.isPayPalResellerEvent(req.body)) {
                await resellerBilling.processPayPalWebhook(req.body, req.headers);
            } else {
                await paypal.processWebhook(req.body, req.headers);
            }
            return res.json({ received: true });
        } catch (error) {
            console.error('PayPal webhook error:', error.message);
            return res.status(400).send('Webhook rejected');
        }
    });

    return router;
}

module.exports = { createWebhookRouter };
