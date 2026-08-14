'use strict';

const crypto = require('crypto');
const lifecycle = require('./lifecycle');
const discounts = require('./discounts');
const { query } = require('../db');

let stripeClient;

function apiKey() {
    return process.env.STRIPE_RESTRICTED_KEY || process.env.STRIPE_API_KEY || '';
}

function enabled() {
    return Boolean(apiKey());
}

function getStripe() {
    if (!enabled()) throw new Error('Stripe is not configured');
    if (!stripeClient) {
        const Stripe = require('stripe');
        stripeClient = new Stripe(apiKey(), {
            apiVersion: '2026-06-24.dahlia',
            appInfo: { name: 'CAPTAiNFiN', version: '1.0.0' }
        });
    }
    return stripeClient;
}

function randomIntegrationIdentifier() {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    let suffix = '';
    for (const byte of crypto.randomBytes(8)) suffix += letters[byte % letters.length];
    return `captainfin_${suffix}`;
}

function subscriptionPeriod(subscription) {
    const items = subscription?.items?.data || [];
    const starts = items.map(i => Number(i.current_period_start)).filter(Number.isFinite);
    const ends = items.map(i => Number(i.current_period_end)).filter(Number.isFinite);
    return {
        start: starts.length ? new Date(Math.min(...starts) * 1000) : new Date(Number(subscription.created || Date.now() / 1000) * 1000),
        end: ends.length ? new Date(Math.max(...ends) * 1000) : null
    };
}

async function ensureStripeCustomer(customerId, email) {
    const existing = await lifecycle.findPaymentCustomer(customerId, 'stripe');
    if (existing) return existing.provider_customer_id;
    const stripe = getStripe();
    const customer = await stripe.customers.create({
        email: email || undefined,
        metadata: { internal_customer_id: customerId }
    });
    await lifecycle.ensurePaymentCustomer({ customerId, provider: 'stripe', providerCustomerId: customer.id });
    return customer.id;
}

async function ensureStripeCoupon(discount, plan) {
    if (discount.stripe_coupon_id) return discount.stripe_coupon_id;
    const stripe = getStripe();
    const params = { duration: 'once', name: discount.code };
    if (discount.discount_type === 'percent') {
        params.percent_off = discount.percent_off;
    } else {
        params.amount_off = discount.fixed_off_minor;
        params.currency = String(discount.currency || plan.currency || 'usd').toLowerCase();
    }
    const coupon = await stripe.coupons.create(params);
    await query('UPDATE discount_codes SET stripe_coupon_id=$1,updated_at=NOW() WHERE id=$2', [coupon.id, discount.id]);
    return coupon.id;
}

async function createCheckout({ customerId, planCode, email, successUrl, cancelUrl, discountCode = null }) {
    const plan = await lifecycle.getProviderPlan(planCode, 'stripe');
    if (!plan) throw new Error('This plan is not configured for Stripe');
    const stripe = getStripe();
    const stripeCustomerId = await ensureStripeCustomer(customerId, email);
    const mode = plan.checkout_mode === 'subscription' ? 'subscription' : 'payment';
    const metadata = {
        internal_customer_id: customerId,
        internal_plan_id: plan.id,
        internal_plan_code: plan.code
    };

    const params = {
        mode,
        customer: stripeCustomerId,
        line_items: [{ price: plan.external_id, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        integration_identifier: randomIntegrationIdentifier()
    };

    if (discountCode) {
        const discount = await discounts.validateForCheckout({ code: discountCode, planId: plan.id, planCode, customerId });
        if (discount.discount_type === 'fixed' && discount.currency && String(discount.currency).toUpperCase() !== String(plan.currency).toUpperCase()) {
            throw new Error("That discount code's currency does not match this plan");
        }
        const couponId = await ensureStripeCoupon(discount, plan);
        params.discounts = [{ coupon: couponId }];
        metadata.internal_discount_code_id = discount.id;
    }

    if (mode === 'subscription') params.subscription_data = { metadata };
    else params.payment_intent_data = { metadata };

    const session = await stripe.checkout.sessions.create(params);
    return { id: session.id, url: session.url };
}

async function createCustomerPortal({ customerId, returnUrl }) {
    const mapping = await lifecycle.findPaymentCustomer(customerId, 'stripe');
    if (!mapping) throw new Error('No Stripe customer exists for this account');
    const session = await getStripe().billingPortal.sessions.create({
        customer: mapping.provider_customer_id,
        return_url: returnUrl
    });
    return { url: session.url };
}

function extractInvoiceSubscriptionId(invoice) {
    const direct = typeof invoice?.subscription === 'string' ? invoice.subscription : invoice?.subscription?.id;
    if (direct) return direct;
    const parent = invoice?.parent?.subscription_details?.subscription;
    return typeof parent === 'string' ? parent : parent?.id || null;
}

async function activateCheckoutSession(session) {
    if (!['paid', 'no_payment_required'].includes(session.payment_status)) return null;
    const customerId = session.metadata?.internal_customer_id;
    const planId = session.metadata?.internal_plan_id;
    const discountCodeId = session.metadata?.internal_discount_code_id || null;
    if (!customerId || !planId) throw new Error('Stripe Checkout session is missing internal metadata');

    const providerCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (session.mode === 'subscription') {
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        if (!subscriptionId) throw new Error('Stripe Checkout subscription ID is missing');
        const subscription = await getStripe().subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
        const period = subscriptionPeriod(subscription);
        return lifecycle.activatePurchase({
            customerId,
            planId,
            provider: 'stripe',
            providerCustomerId,
            providerSubscriptionId: subscription.id,
            providerStatus: subscription.status,
            periodStart: period.start,
            periodEnd: period.end,
            cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
            discountCodeId
        });
    }

    const paymentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || session.id;
    return lifecycle.activatePurchase({
        customerId,
        planId,
        provider: 'stripe',
        providerCustomerId,
        providerSubscriptionId: paymentId,
        providerStatus: 'active',
        discountCodeId
    });
}

async function syncSubscription(subscriptionId, statusOverride = null) {
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
    const period = subscriptionPeriod(subscription);
    return lifecycle.updateProviderSubscription({
        provider: 'stripe',
        providerSubscriptionId: subscription.id,
        providerStatus: statusOverride || subscription.status,
        periodEnd: period.end,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end)
    });
}

async function processWebhook(rawBody, signature) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    const event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
    const eventRow = await lifecycle.beginPaymentEvent({
        provider: 'stripe', eventId: event.id, eventType: event.type, payload: event
    });
    if (!eventRow) return { duplicate: true };

    try {
        const object = event.data?.object;
        switch (event.type) {
            case 'checkout.session.completed':
                await activateCheckoutSession(object);
                break;
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted':
                await syncSubscription(object.id);
                break;
            case 'invoice.paid': {
                const subscriptionId = extractInvoiceSubscriptionId(object);
                if (subscriptionId) await syncSubscription(subscriptionId, 'active');
                break;
            }
            case 'invoice.payment_failed': {
                const subscriptionId = extractInvoiceSubscriptionId(object);
                if (subscriptionId) await syncSubscription(subscriptionId, 'past_due');
                break;
            }
            default:
                break;
        }
        await lifecycle.finishPaymentEvent(eventRow);
        return { duplicate: false, type: event.type };
    } catch (error) {
        await lifecycle.finishPaymentEvent(eventRow, error);
        throw error;
    }
}

module.exports = {
    enabled,
    createCheckout,
    createCustomerPortal,
    processWebhook,
    subscriptionPeriod
};
