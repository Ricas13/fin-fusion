'use strict';

const { deriveServerSecret } = require('../src/jellyfin/playback-webhook-auth');

function tokenFor(masterSecret, serverId) {
    return deriveServerSecret(masterSecret, serverId);
}

function main(argv = process.argv, env = process.env) {
    const serverId = String(argv[2] || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(serverId)) {
        console.error('Usage: node scripts/jellyfin-webhook-token.js <jellyfin-server-uuid>');
        return 2;
    }
    const masterSecret = String(env.JELLYFIN_WEBHOOK_SECRET || '');
    if (!masterSecret) {
        console.error('JELLYFIN_WEBHOOK_SECRET is not configured.');
        return 2;
    }
    process.stdout.write(`${tokenFor(masterSecret, serverId)}\n`);
    return 0;
}

if (require.main === module) {
    require('dotenv').config();
    process.exitCode = main();
}

module.exports = { tokenFor, main };
