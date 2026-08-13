'use strict';

require('dotenv').config();
const { encryptString } = require('../src/crypto');
const { query, getPool } = require('../src/db');

async function main() {
    const [name, slug, serverClass, baseUrl, publicUrl, apiKey, maxUsersRaw] = process.argv.slice(2);
    if (!name || !slug || !['premium', 'free', 'custom'].includes(serverClass) || !baseUrl || !apiKey) {
        throw new Error('Usage: node scripts/add-jellyfin-server.js <name> <slug> <premium|free|custom> <base-url> <public-url|-> <api-key> [max-users]');
    }
    const maxUsers = maxUsersRaw ? Number(maxUsersRaw) : null;
    if (maxUsersRaw && (!Number.isInteger(maxUsers) || maxUsers < 1)) throw new Error('max-users must be a positive integer');

    const result = await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,max_users)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(slug)
        DO UPDATE SET name=EXCLUDED.name,server_class=EXCLUDED.server_class,base_url=EXCLUDED.base_url,
                      public_url=EXCLUDED.public_url,api_key_encrypted=EXCLUDED.api_key_encrypted,
                      max_users=EXCLUDED.max_users,updated_at=NOW()
        RETURNING id,name,slug,server_class,base_url,public_url,max_users
    `, [name, slug, serverClass, baseUrl.replace(/\/+$/, ''), publicUrl === '-' ? null : publicUrl, encryptString(apiKey), maxUsers]);

    console.log(JSON.stringify(result.rows[0], null, 2));
}

main()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
