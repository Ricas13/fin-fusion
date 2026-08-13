'use strict';

/**
 * Bridges the new PostgreSQL customer platform into the legacy Express app
 * without forcing a 50k-line app.js rewrite in one change.
 *
 * Payment webhooks are mounted at Express app creation time, before legacy
 * express.json(), so Stripe/PayPal signature verification receives raw bytes.
 * Customer portal routes are mounted immediately before listen(), after the
 * legacy session middleware has been installed.
 */

const expressPath = require.resolve('express');
const realExpress = require(expressPath);
const { createWebhookRouter } = require('./src/platform/webhooks');

const originalListen = realExpress.application.listen;
let jobsStarted = false;

function startJobs() {
    if (jobsStarted || !process.env.DATABASE_URL) return;
    jobsStarted = true;
    const { expireSubscriptionsAndReconcile } = require('./src/jellyfin/provisioning');

    const run = async () => {
        try {
            const count = await expireSubscriptionsAndReconcile();
            if (count) console.log(`Entitlement job expired/reconciled ${count} customer subscription(s)`);
        } catch (error) {
            console.error('Entitlement expiry job failed:', error.message);
        }
    };

    const initial = setTimeout(run, 15000);
    initial.unref?.();
    const timer = setInterval(run, Number(process.env.ENTITLEMENT_JOB_INTERVAL_MS || 5 * 60 * 1000));
    timer.unref?.();
}

function platformExpress(...args) {
    const app = realExpress(...args);
    app.use(createWebhookRouter());
    return app;
}

Object.assign(platformExpress, realExpress);
platformExpress.application = realExpress.application;
platformExpress.request = realExpress.request;
platformExpress.response = realExpress.response;
require.cache[expressPath].exports = platformExpress;

realExpress.application.listen = function platformListen(...args) {
    if (!this.locals.__platformRoutesMounted && process.env.DATABASE_URL) {
        this.locals.__platformRoutesMounted = true;
        const { createRouter } = require('./src/platform/router');
        this.use(createRouter());
        startJobs();
    }
    return originalListen.apply(this, args);
};
