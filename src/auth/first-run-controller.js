'use strict';

const express = require('express');
const crypto = require('crypto');
const csrf = require('./csrf');
const firstRun = require('./first-run-setup');
const staffController = require('./staff-controller');
const runtimeSettings = require('../platform/runtime-settings');

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}

function regenerate(req) {
    return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
}

function save(req) {
    return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

function setupSession(req) {
    const value = req.session?.firstRunSetup;
    if (!value || !value.authorized || !value.claimCode) return null;
    if (Date.now() - Number(value.authorizedAt || 0) > 30 * 60 * 1000) return null;
    return value;
}

async function currentSiteName() {
    await runtimeSettings.ensureLoaded().catch(() => {});
    return runtimeSettings.siteName();
}

async function renderClaim(req, res, { error = null, status = 200 } = {}) {
    const claim = await firstRun.ensureClaimCode();
    if (!claim.required) return res.redirect(req.session?.authRole === 'admin' ? '/admin' : '/login');
    if (claim.created && claim.code) {
        console.log('');
        console.log('==============================================================');
        console.log(`FIRST-RUN SETUP CODE: ${claim.code}`);
        console.log('Open /setup in your browser and enter this one-time code.');
        console.log('If this code is lost, run: npm run setup:claim');
        console.log('==============================================================');
        console.log('');
    }
    return res.status(status).render('auth/first-run-claim', {
        siteName: await currentSiteName(),
        error,
        csrfToken: csrf.token(req)
    });
}

async function renderSetup(req, res, { error = null, field = null, values = {}, status = 200 } = {}) {
    if (!(await firstRun.isSetupRequired())) return res.redirect('/login');
    const setup = setupSession(req);
    if (!setup) return res.redirect('/setup');
    return res.status(status).render('auth/first-run-setup', {
        siteName: await currentSiteName(),
        error,
        field,
        csrfToken: csrf.token(req),
        values: {
            siteName: String(values.siteName || runtimeSettings.siteName() || 'Steam Fusion'),
            username: String(values.username || ''),
            email: String(values.email || '')
        }
    });
}

function createFirstRunRouter() {
    const router = express.Router();
    router.use('/setup', noStore);

    router.get('/setup', async (req, res, next) => {
        try {
            if (!(await firstRun.isSetupRequired())) {
                return res.redirect(req.session?.authRole === 'admin' ? '/admin' : '/login');
            }
            if (setupSession(req)) return renderSetup(req, res);
            return renderClaim(req, res);
        } catch (error) {
            return next(error);
        }
    });

    router.post('/setup/claim', async (req, res, next) => {
        try {
            if (!(await firstRun.isSetupRequired())) return res.redirect('/login');
            if (!csrf.verify(req)) return renderClaim(req, res, { error: 'The setup form expired. Reload the page and try again.', status: 403 });
            const code = String(req.body.setupCode || '').trim();
            if (!(await firstRun.verifyClaimCode(code))) {
                const attempts = Number(req.session?.firstRunClaimAttempts || 0) + 1;
                req.session.firstRunClaimAttempts = attempts;
                await save(req);
                return renderClaim(req, res, {
                    error: attempts >= 5
                        ? 'That setup code is not valid. Check the server logs or rotate the code with npm run setup:claim.'
                        : 'That setup code is not valid.',
                    status: 401
                });
            }

            await regenerate(req);
            req.session.firstRunSetup = {
                authorized: true,
                authorizedAt: Date.now(),
                claimCode: code,
                nonce: crypto.randomBytes(16).toString('base64url')
            };
            req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
            req.session.cookie.maxAge = 30 * 60 * 1000;
            await save(req);
            return res.redirect('/setup');
        } catch (error) {
            return next(error);
        }
    });

    router.post('/setup/complete', async (req, res, next) => {
        const setup = setupSession(req);
        if (!setup) return res.redirect('/setup');
        if (!csrf.verify(req)) {
            return renderSetup(req, res, {
                error: 'The setup form expired. Reload the page and try again.',
                values: req.body,
                status: 403
            });
        }
        try {
            const user = await firstRun.completeSetup({
                claimCode: setup.claimCode,
                username: req.body.username,
                email: req.body.email,
                password: req.body.password,
                passwordConfirm: req.body.passwordConfirm,
                siteName: req.body.siteName,
                req
            });
            await runtimeSettings.reload();
            await staffController.establishAuthenticatedSession(req, user);
            return res.redirect('/admin');
        } catch (error) {
            if (error.code === 'SETUP_ALREADY_COMPLETED') return res.redirect('/login');
            if (error.code === 'SETUP_CLAIM_INVALID') {
                await regenerate(req);
                return res.redirect('/setup');
            }
            if (error instanceof firstRun.FirstRunValidationError) {
                return renderSetup(req, res, {
                    error: error.message,
                    field: error.field,
                    values: req.body,
                    status: 400
                });
            }
            return next(error);
        }
    });

    router.use('/setup', (error, _req, res, _next) => {
        console.error('First-run setup failed:', error.message);
        return res.status(500).render('auth/message', {
            siteName: runtimeSettings.siteName(),
            title: 'Setup unavailable',
            message: 'First-run setup could not be completed safely. Check the application logs and try again.',
            link: '/setup',
            linkText: 'Return to setup'
        });
    });

    return router;
}

module.exports = { createFirstRunRouter, setupSession };
