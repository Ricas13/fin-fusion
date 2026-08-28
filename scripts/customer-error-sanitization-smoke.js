'use strict';
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const publicError = require('../src/platform/public-error');

// Core sanitizer behavior: known-safe messages pass through verbatim; anything
// else is replaced with a generic message plus a correlation reference, and
// the real error is logged server-side (never sent to the browser).
const rawStripeLike = new Error("No such checkout session: 'cs_test_a1B2c3d4e5'");
const originalConsoleError = console.error;
let loggedRawDetail = false;
console.error = (...args) => { if (args.some(a => String(a && a.message || a).includes('cs_test_a1B2c3d4e5'))) loggedRawDetail = true; };
const sanitized = publicError.present(rawStripeLike, { context: 'test', fallback: 'Something went wrong.' });
console.error = originalConsoleError;
assert(!sanitized.exposed, 'an unrecognized error must never be marked exposed');
assert(!sanitized.message.includes('cs_test_a1B2c3d4e5'), 'raw Stripe session identifiers must never reach the customer-facing message');
assert(/Reference [0-9a-f]{12}\.$/.test(sanitized.message), 'a sanitized message must carry a correlation reference the customer can quote to support');
assert(sanitized.status === 500, 'a sanitized/unexpected error must report status 500');
assert(loggedRawDetail, 'the real error detail must still be logged server-side for support to diagnose using the reference');

const knownSafe = new Error('Plan is not available or is currently sold out.');
const passthrough = publicError.present(knownSafe, { context: 'test', fallback: 'Something went wrong.' });
assert(passthrough.exposed && passthrough.message === knownSafe.message, 'a message already on the global safe list must pass through verbatim');

const flexibleCheckout = require('../src/platform/flexible-checkout');
const localSafe = new Error('You already have recurring Jellyfin access. Manage or cancel that service before starting another recurring subscription.');
const localPass = publicError.present(localSafe, { context: 'test', fallback: 'x', safe: flexibleCheckout.CHECKOUT_SAFE });
assert(localPass.exposed && localPass.message === localSafe.message, 'a route-local safe pattern must also pass through verbatim');
const notLocallySafe = new Error('PayPal HTTP 422: ORDER_ALREADY_CAPTURED');
const localBlocked = publicError.present(notLocallySafe, { context: 'test', fallback: 'Checkout could not be started.', safe: flexibleCheckout.CHECKOUT_SAFE });
assert(!localBlocked.exposed && !localBlocked.message.includes('ORDER_ALREADY_CAPTURED'), 'a raw provider HTTP error must not match a route-local safe pattern and must stay sanitized');

// Static confirmation that the money-facing routes actually call the sanitizer
// instead of interpolating error.message directly into a customer response.
const targets = [
    ['src/platform/customer-payment-return.js', 4],
    ['src/platform/flexible-checkout.js', 5],
    ['src/platform/customer-subscription-actions.js', 2],
    ['src/platform/router.js', 2],
    ['src/platform/customer-dashboard.js', 1]
];
for (const [file] of targets) {
    const source = read(file);
    assert(source.includes("require('./public-error')"), `${file} must use the shared error sanitizer`);
    assert(!/encodeURIComponent\(error\.message/.test(source), `${file} must not interpolate error.message directly into a redirect`);
    assert(!/message:\s*error\.message/.test(source), `${file} must not interpolate error.message directly into a JSON response`);
}

console.log('customer error sanitization smoke: ok');
