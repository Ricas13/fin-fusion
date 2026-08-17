'use strict';

const express = require('express');
const customers = require('../customers');
const referrals = require('../referrals');
const lifecycle = require('../payments/lifecycle');
const stripe = require('../payments/stripe');
const paypal = require('../payments/paypal');
const provisioning = require('../jellyfin/resilient-provisioning');
const requestUserSync = require('../integrations/request-user-sync');
const emailSettings = require('../integrations/email-settings');
const emailOutbox = require('../integrations/email-outbox');
const policy = require('../jellyfin/policy');
const csrf = require('../auth/csrf');
const { createAdminActionsRouter } = require('./admin-actions');
const runtimeSettings = require('./runtime-settings');
const operationsSettings = require('./operations-settings');

async function absoluteUrl(req, path) {
    // Legacy routes are currently pruned from the live router, but keep their
    // URL generation fail-closed as well: if one is ever re-mounted, external
    // links still come from the same canonical origin as the modern routers.
    return operationsSettings.absoluteUrl(req, path);
}

function requireCustomer(req, res, next) {
    if (req.session?.customerId && req.session?.customerUserId) return next();
    return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl || '/account'));
}

function safeNext(value) {
    const next = String(value || '');
    return next.startsWith('/') && !next.startsWith('//') ? next : '/account';
}

function htmlEsc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
}

function emailFrame(site, title, copy, actionLabel, actionUrl) {
    return `<!doctype html><html><body style="margin:0;background:#0d1117;color:#e8edf3;font-family:Arial,sans-serif"><div style="max-width:620px;margin:0 auto;padding:32px 20px"><div style="font-size:20px;font-weight:700;margin-bottom:24px">${htmlEsc(site)}</div><div style="background:#151b22;border:1px solid #2b3440;border-radius:12px;padding:24px"><h1 style="font-size:24px;margin:0 0 12px">${htmlEsc(title)}</h1><p style="color:#aab5c1;line-height:1.6">${htmlEsc(copy)}</p><p style="margin:24px 0"><a href="${htmlEsc(actionUrl)}" style="display:inline-block;background:#163844;border:1px solid #2d6474;color:#ecfbff;text-decoration:none;padding:11px 18px;border-radius:7px;font-weight:700">${htmlEsc(actionLabel)}</a></p><p style="color:#748295;font-size:12px;line-height:1.5">If the button does not work, copy this address into your browser:<br>${htmlEsc(actionUrl)}</p></div></div></body></html>`;
}

async function registrationLocals(req, error = null, rawReferralCode = '') {
    await runtimeSettings.ensureLoaded();
    const referralSettings = await referrals.loadSettings();
    return {
        error,
        registrationOpen: runtimeSettings.publicRegistrationOpen(),
        referralsEnabled: referralSettings.enabled,
        referralCode: referralSettings.enabled ? String(rawReferralCode || '').slice(0, 20) : '',
        siteName: runtimeSettings.siteName()
    };
}

function createRouter() {
    const router = express.Router();

    router.use(createAdminActionsRouter());

    router.get('/account/register', async (req, res, next) => {
        try { return res.render('customer/register', await registrationLocals(req, null, req.query.ref)); }
        catch (error) { return next(error); }
    });

    router.post('/account/register', async (req, res) => {
        try {
            await runtimeSettings.ensureLoaded();
            if (runtimeSettings.requireEmailVerification()) {
                const mail = await emailSettings.status();
                if (!mail.configured) {
                    throw new Error('Registration requires email verification, but transactional email is not configured. Please contact support.');
                }
            }

            const created = await customers.registerCustomer({ ...req.body, referralCode: req.body.referralCode });
            req.session.customerUserId = created.user.id;
            req.session.customerId = created.customer.id;
            req.session.customerUsername = created.user.username;
            if (runtimeSettings.requireEmailVerification()) {
                const verification = await customers.createAccountToken(created.user.id, 'email_verify', 24 * 60);
                const site = runtimeSettings.siteName();
                const url = await absoluteUrl(req, `/account/verify-email?token=${encodeURIComponent(verification.token)}`);
                await emailOutbox.enqueue({
                    type: 'email_verification',
                    to: created.user.email,
                    subject: `Verify your ${site} email address`,
                    text: `Welcome to ${site}. Verify your email address using this secure link: ${url}\n\nThis link expires in 24 hours.`,
                    html: emailFrame(site, 'Verify your email address', 'Your account has been created. Verify your email address to finish setting up your customer portal.', 'Verify email', url),
                    dedupeKey: `verify:${created.user.id}:${verification.expiresAt.toISOString()}`
                });
                if (process.env.NODE_ENV !== 'production') console.log(`Development email verification URL: ${url}`);
                req.session.destroy(() => {});
                return res.render('customer/message', {
                    title: 'Check your email',
                    message: 'Your account has been created. A verification link has been queued for delivery.',
                    siteName: site
                });
            }
            return res.redirect('/account');
        } catch (error) {
            return res.status(400).render('customer/register', await registrationLocals(req, error.message, req.body.referralCode));
        }
    });

    router.get('/account/verify-email', async (req, res) => {
        await runtimeSettings.ensureLoaded();
        const ok = await customers.verifyEmail(req.query.token);
        return res.status(ok ? 200 : 400).render('customer/message', {
            title: ok ? 'Email verified' : 'Verification failed',
            message: ok ? 'Your email is verified. You can now sign in.' : 'This verification link is invalid or has expired.',
            siteName: runtimeSettings.siteName()
        });
    });

    router.get('/account/login', async (req, res) => {
        await runtimeSettings.ensureLoaded();
        return res.render('customer/login', {
            error: req.query.reset ? null : null,
            next: safeNext(req.query.next),
            siteName: runtimeSettings.siteName()
        });
    });

    router.post('/account/login', async (req, res) => {
        try {
            const account = await customers.authenticateCustomer(req.body.identity, req.body.password);
            if (!account) throw new Error('Invalid email/username or password');
            req.session.customerUserId = account.userId;
            req.session.customerId = account.customerId;
            req.session.customerUsername = account.username;
            return res.redirect(safeNext(req.body.next));
        } catch (error) {
            await runtimeSettings.ensureLoaded();
            return res.status(401).render('customer/login', {
                error: error.message,
                next: safeNext(req.body.next),
                siteName: runtimeSettings.siteName()
            });
        }
    });

    router.get('/account/forgot-password', async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            return res.render('customer/forgot-password', {
                error: null,
                csrfToken: csrf.token(req),
                siteName: runtimeSettings.siteName()
            });
        } catch (error) { return next(error); }
    });

    router.post('/account/forgot-password', async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            if (!csrf.verify(req)) {
                return res.status(403).render('customer/forgot-password', {
                    error: 'Your form expired. Please try again.',
                    csrfToken: csrf.token(req),
                    siteName: runtimeSettings.siteName()
                });
            }
            const mail = await emailSettings.status();
            if (!mail.configured) {
                return res.status(503).render('customer/message', {
                    title: 'Password reset unavailable',
                    message: 'Email password reset is not configured right now. Please contact support.',
                    siteName: runtimeSettings.siteName()
                });
            }
            const reset = await customers.createPasswordReset(req.body.identity, 60);
            if (reset) {
                const site = runtimeSettings.siteName();
                const url = await absoluteUrl(req, `/account/reset-password?token=${encodeURIComponent(reset.token)}`);
                await emailOutbox.enqueue({
                    type: 'password_reset',
                    to: reset.email,
                    subject: `Reset your ${site} password`,
                    text: `A password reset was requested for your ${site} customer account. Use this secure link: ${url}\n\nThis link expires in 60 minutes. If you did not request it, you can ignore this message.`,
                    html: emailFrame(site, 'Reset your portal password', 'A password reset was requested for your customer portal account. This does not change your Jellyfin password.', 'Reset password', url),
                    dedupeKey: `password-reset:${reset.user_id}:${reset.expiresAt.toISOString()}`
                });
            }
            return res.render('customer/message', {
                title: 'Check your email',
                message: 'If a matching customer account with an email address exists, a secure reset link has been queued for delivery.',
                siteName: runtimeSettings.siteName()
            });
        } catch (error) { return next(error); }
    });

    router.get('/account/reset-password', async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            const token = String(req.query.token || '');
            if (!token) {
                return res.status(400).render('customer/message', {
                    title: 'Reset link invalid',
                    message: 'This password reset link is invalid or incomplete.',
                    siteName: runtimeSettings.siteName()
                });
            }
            return res.render('customer/reset-password', {
                error: null,
                token,
                csrfToken: csrf.token(req),
                siteName: runtimeSettings.siteName()
            });
        } catch (error) { return next(error); }
    });

    router.post('/account/reset-password', async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            const token = String(req.body.token || '');
            const locals = { token, csrfToken: csrf.token(req), siteName: runtimeSettings.siteName() };
            if (!csrf.verify(req)) return res.status(403).render('customer/reset-password', { ...locals, error: 'Your form expired. Please try again.' });
            if (String(req.body.password || '') !== String(req.body.confirmPassword || '')) {
                return res.status(400).render('customer/reset-password', { ...locals, error: 'Passwords do not match.' });
            }
            const ok = await customers.resetSitePassword(token, req.body.password);
            if (!ok) return res.status(400).render('customer/reset-password', { ...locals, error: 'This reset link is invalid, expired or has already been used.' });
            return res.render('customer/message', {
                title: 'Password updated',
                message: 'Your portal password has been updated. Your Jellyfin password was not changed.',
                siteName: runtimeSettings.siteName()
            });
        } catch (error) {
            await runtimeSettings.ensureLoaded();
            return res.status(400).render('customer/reset-password', {
                error: error.message,
                token: String(req.body.token || ''),
                csrfToken: csrf.token(req),
                siteName: runtimeSettings.siteName()
            });
        }
    });

    router.post('/account/logout', requireCustomer, (req, res) => req.session.destroy(() => res.redirect('/account/login')));

    router.get('/account', requireCustomer, async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            const [portal, plans, currentPlan, requestAccess, requestConfig] = await Promise.all([
                customers.getCustomerPortal(req.session.customerId),
                customers.listPublicPlans(),
                provisioning.currentEntitlement(req.session.customerId),
                requestUserSync.requestAccessForCustomer(req.session.customerId),
                requestUserSync.configuration()
            ]);
            const effective = currentPlan ? await provisioning.effectivePolicyForCustomer(req.session.customerId, currentPlan) : null;
            const libraryEntitlement = effective ? effective.entitlementRows.filter(row => row.effective).map(row => row.name) : [];
            const librarySelection = effective ? effective.visibleNames : [];
            return res.render('customer/dashboard', {
                portal,
                plans,
                currentPlan,
                stripeEnabled: stripe.enabled(),
                paypalEnabled: paypal.enabled(),
                overseerrUrl: runtimeSettings.overseerrUrl(),
                requestAccess,
                requestSyncConfigured: requestConfig.configured,
                libraryEntitlement,
                librarySelection,
                csrfToken: csrf.token(req),
                siteName: runtimeSettings.siteName(),
                message: req.query.message || null,
                error: req.query.error || null
            });
        } catch (error) { return next(error); }
    });

    router.post('/account/libraries', requireCustomer, async (req, res) => {
        if (!csrf.verify(req)) return res.redirect('/account?error=' + encodeURIComponent('Invalid or expired security token'));
        try {
            const plan = await provisioning.currentEntitlement(req.session.customerId);
            const effective = await provisioning.effectivePolicyForCustomer(req.session.customerId, plan);
            const submitted = Array.isArray(req.body.library) ? req.body.library : (req.body.library !== undefined ? [req.body.library] : []);
            const chosen = [];
            for (const raw of submitted) {
                const name = String(raw || '').trim();
                if (!name) continue;
                const match = effective.entitlementRows.find(row => row.effective && policy.nameKey(row.name) === policy.nameKey(name));
                if (match) chosen.push(match.name);
            }
            await provisioning.setLibrarySelection(req.session.customerId, chosen);
            try { await provisioning.reconcileCustomer(req.session.customerId); } catch (_) {}
            return res.redirect('/account?message=' + encodeURIComponent('Library visibility updated.'));
        } catch (_) {
            return res.redirect('/account?error=' + encodeURIComponent('Library visibility could not be updated safely.'));
        }
    });

    router.post('/account/requests/password', requireCustomer, async (req, res) => {
        if (!csrf.verify(req)) return res.redirect('/account?error=' + encodeURIComponent('Invalid or expired security token'));
        try {
            if (req.body.password !== req.body.confirmPassword) throw new Error('Request-site passwords do not match.');
            await requestUserSync.setCustomerPassword(req.session.customerId, req.body.password);
            return res.redirect('/account?message=' + encodeURIComponent('Request-site password updated.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message || 'Request-site password could not be updated.'));
        }
    });

    router.post('/account/trial/start', requireCustomer, async (req, res) => {
        try {
            await lifecycle.startFreeTrial(req.session.customerId, req.body.planCode || null);
            return res.redirect('/account?message=' + encodeURIComponent('Your trial access is active.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/account/claim-free/:planCode', requireCustomer, async (req, res) => {
        try {
            await lifecycle.claimFreePlan(req.session.customerId, req.params.planCode);
            return res.redirect('/account?welcome=1&message=' + encodeURIComponent('Free Access claimed. We are preparing your Jellyfin account now.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/account/checkout/stripe', requireCustomer, async (req, res) => {
        try {
            const portal = await customers.getCustomerPortal(req.session.customerId);
            const checkout = await stripe.createCheckout({
                customerId: req.session.customerId,
                planCode: req.body.planCode,
                email: portal?.customer?.login_email || portal?.customer?.email,
                discountCode: req.body.discountCode || null,
                successUrl: await absoluteUrl(req, '/account?message=Payment%20received'),
                cancelUrl: await absoluteUrl(req, '/account?error=Checkout%20cancelled')
            });
            return res.redirect(303, checkout.url);
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/account/stripe/portal', requireCustomer, async (req, res) => {
        try {
            const portal = await stripe.createCustomerPortal({ customerId: req.session.customerId, returnUrl: await absoluteUrl(req, '/account') });
            return res.redirect(303, portal.url);
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/account/checkout/paypal', requireCustomer, async (req, res) => {
        try {
            const checkout = await paypal.createCheckout({
                customerId: req.session.customerId,
                planCode: req.body.planCode,
                discountCode: req.body.discountCode || null,
                returnUrl: await absoluteUrl(req, '/account/paypal/return'),
                cancelUrl: await absoluteUrl(req, '/account?error=PayPal%20checkout%20cancelled')
            });
            req.session.pendingPayPal = { id: checkout.id, mode: checkout.mode };
            return res.redirect(303, checkout.url);
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    router.get('/account/paypal/return', requireCustomer, async (req, res) => {
        try {
            const pending = req.session.pendingPayPal || {};
            if (pending.mode === 'payment') {
                const orderId = req.query.token || pending.id;
                if (!orderId || orderId !== pending.id) throw new Error('PayPal order does not match this session');
                await paypal.captureOrder(orderId);
            } else {
                const subscriptionId = req.query.subscription_id || pending.id;
                if (!subscriptionId || subscriptionId !== pending.id) throw new Error('PayPal subscription does not match this session');
                await paypal.activateSubscription(subscriptionId);
            }
            delete req.session.pendingPayPal;
            return res.redirect('/account?message=' + encodeURIComponent('PayPal payment completed.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/account/jellyfin/:accountId/password', requireCustomer, async (req, res) => {
        try {
            await provisioning.setJellyfinPassword(req.session.customerId, req.params.accountId, req.body.password);
            return res.redirect('/account?message=' + encodeURIComponent('Jellyfin password updated.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    router.get('/api/platform/plans', async (_req, res, next) => {
        try { return res.json(await customers.listPublicPlans()); }
        catch (error) { return next(error); }
    });

    router.use((error, req, res, _next) => {
        console.error('Platform route error:', error);
        if (req.path.startsWith('/api/')) return res.status(500).json({ success: false, error: 'Internal server error' });
        return res.status(500).render('customer/message', {
            title: 'Something went wrong',
            message: 'The request could not be completed. Please try again.',
            siteName: runtimeSettings.siteName()
        });
    });

    return router;
}

module.exports = { createRouter, requireCustomer, registrationLocals };
