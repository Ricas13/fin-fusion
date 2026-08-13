'use strict';

require('dotenv').config();
const { query, getPool } = require('../src/db');
const { decryptString } = require('../src/crypto');
const { encryptWithEnv } = require('../src/security/purpose-crypto');

async function main() {
    if (!process.env.DATA_ENCRYPTION_KEY) throw new Error('DATA_ENCRYPTION_KEY is required to read legacy values');
    if (!process.env.JELLYFIN_ENCRYPTION_KEY) throw new Error('JELLYFIN_ENCRYPTION_KEY is required');

    const result = await query(`SELECT id,name,api_key_encrypted FROM jellyfin_servers ORDER BY name`);
    let rotated = 0;
    for (const server of result.rows) {
        const payload = String(server.api_key_encrypted || '');
        if (payload.startsWith('jf1:')) continue;
        if (!payload.startsWith('v1:')) throw new Error(`Unsupported key format for ${server.name}`);
        const plain = decryptString(payload);
        const next = encryptWithEnv(plain, 'JELLYFIN_ENCRYPTION_KEY', 'jf1');
        await query(`UPDATE jellyfin_servers SET api_key_encrypted=$1,updated_at=NOW() WHERE id=$2`, [next, server.id]);
        rotated += 1;
    }
    console.log(`Rotated ${rotated} Jellyfin server key(s)`);
}

main()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
