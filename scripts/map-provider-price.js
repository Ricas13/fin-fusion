'use strict';

require('dotenv').config();
const { query, getPool } = require('../src/db');

async function main() {
    const [provider, planCode, externalId, checkoutMode] = process.argv.slice(2);
    if (!['stripe', 'paypal'].includes(provider)) {
        throw new Error('Usage: npm run payments:map -- <stripe|paypal> <plan-code> <external-id> <payment|subscription>');
    }
    if (!planCode || !externalId || !['payment', 'subscription'].includes(checkoutMode)) {
        throw new Error('Usage: npm run payments:map -- <stripe|paypal> <plan-code> <external-id> <payment|subscription>');
    }

    const plan = await query('SELECT id,name FROM plans WHERE code=$1', [planCode]);
    if (!plan.rowCount) throw new Error(`Unknown plan code: ${planCode}`);

    const result = await query(`
        INSERT INTO plan_provider_prices(plan_id,provider,external_id,checkout_mode,active)
        VALUES($1,$2,$3,$4,TRUE)
        ON CONFLICT(plan_id,provider)
        DO UPDATE SET external_id=EXCLUDED.external_id,checkout_mode=EXCLUDED.checkout_mode,active=TRUE,updated_at=NOW()
        RETURNING provider,external_id,checkout_mode
    `, [plan.rows[0].id, provider, externalId, checkoutMode]);

    console.log(`Mapped ${planCode} (${plan.rows[0].name}) -> ${provider}:${result.rows[0].external_id} [${result.rows[0].checkout_mode}]`);
}

main()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
