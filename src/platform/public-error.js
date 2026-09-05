'use strict';

const crypto = require('crypto');

const SAFE_CODES = new Set([
    'EMAIL_NOT_VERIFIED',
    'PASSWORD_BREACHED',
    'PASSWORD_BREACH_CHECK_UNAVAILABLE'
]);

const SAFE_MESSAGES = [
    /^A valid email address is required\.?$/,
    /^Enter a valid email address\.$/,
    /^Username must be 3(?:-|–)40 characters using letters, numbers, dot, underscore or dash\.?$/,
    /^Display name is required\.?$/,
    /^Password must be between 8 and 200 characters\.?$/,
    /^Public registration is currently disabled$/,
    /^An account already exists with that email or username$/,
    /^That username belongs to an existing Jellyfin account\./,
    /^Registration is not available for this email address$/,
    /^Registration requires email verification, but transactional email is not configured\. Please contact support\.$/,
    /^Email verification is required, but transactional email is not configured\.$/,
    /^Please verify your email address before signing in$/,
    /^Invalid email\/username or password$/,
    /^Current password was not accepted\.$/,
    /^New password must be different from the current password\.$/,
    /^That email address is already in use\.$/,
    /^Customer account not found\.$/,
    /^New passwords do not match\.$/,
    /^Passwords do not match\.$/,
    /^The 2FA setup session expired\. Start again\.$/,
    /^Authenticator code was not accepted\.$/,
    /^Authenticator or recovery code was not accepted\.$/,
    /^Two-factor authentication is temporarily locked after repeated failures\.$/,
    /^This account is temporarily locked after repeated security-code failures\. Try again later\.$/,
    /^Two-factor authentication is temporarily locked until .+ after repeated failed codes\.$/,
    /^This account is temporarily unavailable\.$/,
    /^Choose a different password\. This password appears in known breach data and is not safe to use\.$/,
    /^Password safety checking is temporarily unavailable\. Try again shortly\.$/,
    /^Plan is not available or is currently sold out\.$/,
    /^This free plan is not available\.$/,
    /^This Free Access reservation is not valid\.$/,
    /^Your Free Access hold has expired\.$/,
    /^Free primary access cannot be claimed from an add-on product\.$/,
    /^You already have free access on this plan\.$/,
    /^Free access on this plan has already been claimed\.$/,
    /^This claim link is invalid or expired\.$/,
    /^This claim link is invalid\.$/,
    /^This account has already been claimed\.$/,
    /^This claim link has been revoked\.$/,
    /^This claim link has expired\.$/,
    /^This claim link is assigned to a different email address\.$/,
    /^That username or email is already in use\.$/
];

function isSafe(error) {
    if (!error || typeof error.message !== 'string') return false;
    if (error.expose === true) return true;
    if (error.code && SAFE_CODES.has(String(error.code))) return true;
    return SAFE_MESSAGES.some(pattern => pattern.test(error.message));
}

function safeStatus(value, fallback) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 400 && status <= 499) return status;
    return fallback;
}

function matchesSafe(error, patterns) {
    if (!error || typeof error.message !== 'string' || !patterns || !patterns.length) return false;
    return patterns.some(pattern => pattern instanceof RegExp ? pattern.test(error.message) : pattern === error.message);
}

function present(error, {
    context = 'Customer request failed',
    fallback = 'Something went wrong. Please try again.',
    status = 400,
    safe = []
} = {}) {
    if (isSafe(error) || matchesSafe(error, safe)) {
        return {
            exposed: true,
            message: error.message,
            status: safeStatus(error.status, status),
            reference: null
        };
    }

    const reference = crypto.randomBytes(6).toString('hex');
    console.error(`${context} [${reference}]`, error);
    return {
        exposed: false,
        message: `${fallback} Reference ${reference}.`,
        status: 500,
        reference
    };
}

module.exports = { SAFE_CODES, SAFE_MESSAGES, isSafe, present, matchesSafe };
