'use strict';

const referrals = require('../referrals');
const runtimeSettings = require('./runtime-settings');
const { createRuntimeLegacyRouter, requireCustomer } = require('./router-runtime-legacy');

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

// Compatibility constructor for any older direct import of router-core. The
// historical module no longer owns customer auth, payment, trial or account
// routes; those workflows have dedicated canonical routers. Returning the
// explicit runtime compatibility surface preserves the module API without
// keeping a second route implementation alive.
function createRouter() {
    return createRuntimeLegacyRouter();
}

module.exports = { createRouter, requireCustomer, registrationLocals };
