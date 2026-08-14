'use strict';

const { query } = require('../db');

// A small in-memory cache over the 'platform' platform_settings row, so
// operational config that used to be env-only can be admin-edited (see
// admin-original-settings.js) and take effect immediately -- without forcing
// every read site to become async. Call sites use the synchronous getters
// below; they fall back to the equivalent env var whenever a value hasn't
// been explicitly set in the admin UI, so upgrading an existing deployment
// with no platform_settings row changes nothing until an admin opts in.

let cache = null;
let loadingPromise = null;

async function reload() {
    const result = await query("SELECT setting_value FROM platform_settings WHERE setting_key='platform'");
    cache = result.rows[0]?.setting_value && typeof result.rows[0].setting_value === 'object'
        ? result.rows[0].setting_value
        : {};
    return cache;
}

async function ensureLoaded() {
    if (cache) return cache;
    if (!loadingPromise) loadingPromise = reload().finally(() => { loadingPromise = null; });
    return loadingPromise;
}

function publicRegistrationOpen() {
    const stored = cache?.publicRegistration;
    return typeof stored === 'boolean' ? stored : process.env.PUBLIC_REGISTRATION !== 'false';
}

function requireEmailVerification() {
    const stored = cache?.requireEmailVerification;
    return typeof stored === 'boolean' ? stored : process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
}

function requireAdminTwoFactor() {
    const stored = cache?.requireAdminTwoFactor;
    // 2FA is optional by default. An explicit runtime setting or env=true can
    // make it mandatory for administrator sign-in without changing code.
    return typeof stored === 'boolean' ? stored : process.env.REQUIRE_ADMIN_2FA === 'true';
}

function entitlementJobIntervalMs() {
    const stored = Number(cache?.entitlementJobIntervalMs);
    return Number.isFinite(stored) && stored >= 30000 ? stored : Number(process.env.ENTITLEMENT_JOB_INTERVAL_MS || 5 * 60 * 1000);
}

function serverHealthIntervalMs() {
    const stored = Number(cache?.serverHealthIntervalMs);
    return Number.isFinite(stored) && stored >= 30000 ? stored : Number(process.env.SERVER_HEALTH_INTERVAL_MS || 5 * 60 * 1000);
}

function overseerrUrl() {
    return typeof cache?.overseerrUrl === 'string' ? cache.overseerrUrl.trim() : '';
}

module.exports = {
    reload,
    ensureLoaded,
    publicRegistrationOpen,
    requireEmailVerification,
    requireAdminTwoFactor,
    entitlementJobIntervalMs,
    serverHealthIntervalMs,
    overseerrUrl
};
