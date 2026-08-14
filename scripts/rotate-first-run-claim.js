'use strict';

require('dotenv').config();
const { ensureClaimCode, isSetupRequired } = require('../src/auth/first-run-setup');
const { getPool } = require('../src/db');

(async () => {
    if (!(await isSetupRequired())) {
        throw new Error('First-run setup is already locked because an administrator exists.');
    }
    const claim = await ensureClaimCode({ rotate: true });
    if (!claim.code) throw new Error('A new first-run setup code could not be generated.');
    console.log(`FIRST-RUN SETUP CODE: ${claim.code}`);
    console.log('Open /setup in your browser and enter this one-time code.');
})().catch(error => {
    console.error(`first-run claim rotation failed: ${error.message}`);
    process.exitCode = 1;
}).finally(async () => {
    try { await getPool().end(); } catch (_) {}
});
