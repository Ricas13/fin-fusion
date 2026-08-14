'use strict';

const express = require('express');
const customers = require('../customers');
const lifecycle = require('../payments/lifecycle');
const stripe = require('../payments/stripe');
const paypal = require('../payments/paypal');
const providerSettings = require('../payments/provider-settings');
const csrf = require('../auth/csrf');

function absoluteUrl(req, path) {
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${proto}://${host}${path}`;
}

function requireCustomer(req, res, next) {
    if (req.session?.customerId && req.session?.customerUserId) return next();
    return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl || '/account'));
}

function priceLabel(plan) {
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: plan.currency || 'USD' }).format(Number(plan.price_minor || 0) / 100);
    } catch (_) {
        return `${plan.currency || 'USD'} ${(Number(plan.price_minor || 0) / 100).toFixed(2)}`;
    }
}

async function chooseOrResolve(req, res, provider) {
    const planCode = String(req.body.planCode || '').trim();
    if (!planCode) throw new Error('Plan is required');
    const options = await lifecycle.getProviderOptions(planCode, provider);
    if (!options.length) throw new Error(`This plan is not configured for ${provider === 'stripe' ? 'Stripe' : 'PayPal'}`);

    const requested = ['payment','subscription'].includes(req.body.checkoutMode) ? req.body.checkoutMode : null;
    if (requested) {
        if (req.body._csrf && !csrf.verify(req)) throw new Error('Invalid or expired security token');
        const match = options.find(option => option.checkout_mode === requested);
        if (!match) throw new Error('That payment type is not available for this plan');
        if (provider === 'paypal' && requested === 'subscription' && req.body.discountCode) {
            throw new Error('PayPal discount codes currently apply only to one-time payments');
        }
        return { mode: requested, planCode, options };
    }

    if (options.length === 1) return { mode: options[0].checkout_mode, planCode, options };

    return res.render('customer/payment-choice', {
        siteName: process.env.SITE_NAME || 'CAPTaINFiN',
        provider,
        planCode,
        planName: options[0].name,
        priceLabel: priceLabel(options[0]),
        options,
        discountCode: String(req.body.discountCode || '').trim().slice(0, 40),
        csrfToken: csrf.token(req)
    });
}

function createFlexibleCheckoutRouter() {
    const router = express.Router();

    // Database-backed payment credentials must be loaded before any downstream
    // route evaluates stripe.enabled()/paypal.enabled(). This runs once per
    // process in practice because providerSettings caches the decrypted values.
    router.use(async (_req, _res, next) => {
        try { await providerSettings.ensureLoaded(); return next(); }
        catch (error) { return next(error); }
    });

    router.post('/account/checkout/stripe', requireCustomer, async (req, res) => {
        try {
            const choice = await chooseOrResolve(req, res, 'stripe');
            if (!choice || res.headersSent) return;
            const portal = await customers.getCustomerPortal(req.session.customerId);
            const checkout = await stripe.createCheckout({
                customerId: req.session.customerId,
                planCode: choice.planCode,
                checkoutMode: choice.mode,
                email: portal?.customer?.login_email || portal?.customer?.email,
                discountCode: req.body.discountCode || null,
                successUrl: absoluteUrl(req, '/account?message=Payment%20received'),
                cancelUrl: absoluteUrl(req, '/account?error=Checkout%20cancelled')
            });
            return res.redirect(303, checkout.url);
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message || 'Stripe checkout could not be started.'));
        }
    });

    router.post('/account/checkout/paypal', requireCustomer, async (req, res) => {
        try {
            const choice = await chooseOrResolve(req, res, 'paypal');
            if (!choice || res.headersSent) return;
            const checkout = await paypal.createCheckout({
                customerId: req.session.customerId,
                planCode: choice.planCode,
                checkoutMode: choice.mode,
                discountCode: req.body.discountCode || null,
                returnUrl: absoluteUrl(req, '/account/paypal/return'),
                cancelUrl: absoluteUrl(req, '/account?error=PayPal%20checkout%20cancelled')
            });
            req.session.pendingPayPal = { id: checkout.id, mode: checkout.mode };
            return res.redirect(303, checkout.url);
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message || 'PayPal checkout could not be started.'));
        }
    });

    return router;
}

module.exports = { createFlexibleCheckoutRouter, priceLabel };
