'use strict';

require('dotenv').config();
const { getPool } = require('../src/db');
const activity = require('../src/jellyfin/activity');

const intervalSeconds = Math.max(10, Math.min(300, Number(process.env.STREAM_POLICY_POLL_SECONDS || 30)));
let shuttingDown = false;

async function run() {
    while (!shuttingDown) {
        const started = Date.now();
        try {
            const result = await activity.runActivityPolicyCycle();
            if (!result.skipped) {
                console.log(`Activity cycle mode=${result.mode} streams=${result.observedStreams} violations=${result.violations} durationMs=${Date.now() - started}`);
            }
        } catch (error) {
            console.error('Activity cycle failed:', error.message);
        }
        await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
    }
}

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await getPool().end(); } catch (_) {}
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

run().catch(async error => {
    console.error('Activity worker fatal error:', error.message);
    try { await getPool().end(); } catch (_) {}
    process.exit(1);
});
