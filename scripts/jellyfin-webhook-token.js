'use strict';

require('dotenv').config();
const { deriveServerSecret } = require('../src/jellyfin/playback-webhook-auth');

const serverId = String(process.argv[2] || '').trim();
if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(serverId)) {
    console.error('Usage: node scripts/jellyfin-webhook-token.js <jellyfin-server-uuid>');
    process.exit(2);
}
const masterSecret = String(process.env.JELLYFIN_WEBHOOK_SECRET || '');
if (!masterSecret) {
    console.error('JELLYFIN_WEBHOOK_SECRET is not configured.');
    process.exit(2);
}
process.stdout.write(`${deriveServerSecret(masterSecret, serverId)}\n`);
