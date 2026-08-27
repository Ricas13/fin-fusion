'use strict';

const referrals = require('../referrals');
const runtimeSettings = require('./runtime-settings');

function requireCustomer(req, res, next) {
    if (req.session?.customerId && req.session?.customerUserId) return next();
    return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl || '/account'));
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

// Compatibility constructor for older direct imports only. Production routes
// now all have named canonical owners, so router-core deliberately returns an
// empty pass-through middleware instead of reconstructing a second route tree.
function createRouter() {
    return function retiredRouterCore(_req, _res, next) { return next(); };
}

module.exports = { createRouter, requireCustomer, registrationLocals };
