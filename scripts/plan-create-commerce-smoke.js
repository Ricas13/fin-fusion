'use strict';

const { query, getPool } = require('../src/db');
const { planCreateInput, createPlanRecord } = require('../src/platform/admin-catalog-shell');

const CODES = [
    'smoke-direct-monthly',
    'smoke-direct-custom',
    'smoke-direct',
    'smoke-stremio-addon',
    'smoke-bundle'
];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function cleanup() {
    await query('DELETE FROM plans WHERE code = ANY($1::text[])', [CODES]);
}

async function main() {
    await cleanup();
    try {
        const monthly = planCreateInput({
            code: 'smoke-direct-monthly',
            name: 'Smoke Direct Monthly',
            description: 'Plan create commerce smoke',
            billingInterval: 'month',
            durationDays: '999',
            price: '4.50',
            currency: 'gbp',
            serverClass: 'premium',
            visible: 'on',
            active: 'on'
        });
        assert(monthly.duration === 30, 'Monthly frequency did not normalize to 30 days');
        assert(monthly.priceMinor === 450 && monthly.currency === 'GBP', 'Price/currency parsing failed');
        assert(monthly.audience === 'direct', 'Plans must always be created for the direct audience');

        const created = await createPlanRecord(monthly, null);
        const stored = (await query('SELECT * FROM plans WHERE id=$1', [created.id])).rows[0];
        assert(stored.billing_interval === 'month' && Number(stored.duration_days) === 30, 'Stored frequency/duration incorrect');
        assert(Number(stored.price_minor) === 450 && stored.currency === 'GBP', 'Stored pricing incorrect');
        assert(stored.audience === 'direct', 'Stored audience incorrect');

        const custom = planCreateInput({
            code: 'smoke-direct-custom',
            name: 'Smoke Direct Custom',
            billingInterval: 'custom',
            durationDays: '45',
            price: '12',
            currency: 'EUR',
            serverClass: 'custom',
            visible: 'on',
            active: 'on'
        });
        assert(custom.duration === 45, 'Custom duration was not retained');
        await createPlanRecord(custom, null);

        const direct = planCreateInput({
            code: 'smoke-direct',
            name: 'Smoke Direct',
            billingInterval: 'year',
            durationDays: '3',
            price: '50.00',
            currency: 'USD',
            serverClass: 'premium',
            visible: 'on',
            active: 'on'
        });
        assert(direct.duration === 365, 'Yearly frequency did not normalize to 365 days');
        await createPlanRecord(direct, null);

        // Regression for the actual Stremio-only plan workflow used by operators.
        const stremio = planCreateInput({
            code: 'smoke-stremio-addon',
            name: 'Stremio Addon',
            description: 'Access to a stremio addon',
            serviceType: 'stremio',
            billingInterval: 'month',
            durationDays: '30',
            price: '6',
            currency: 'USD',
            capacityLimit: '20',
            streams: '1',
            sortOrder: '100',
            visible: 'on',
            active: 'on'
        });
        assert(stremio.serviceType === 'stremio' && stremio.isAddon === false, 'Stremio product classification changed unexpectedly');
        const createdStremio = await createPlanRecord(stremio, null);
        const storedStremio = (await query('SELECT * FROM plans WHERE id=$1', [createdStremio.id])).rows[0];
        assert(storedStremio.service_type === 'stremio', 'Stremio plan did not persist its delivery type');
        assert(Number(storedStremio.capacity_limit) === 20 && Number(storedStremio.streams) === 1, 'Stremio plan inventory/playback contract was not stored');

        const bundle = planCreateInput({
            code: 'smoke-bundle',
            name: 'Smoke Bundle',
            description: 'Jellyfin and Stremio bundle',
            serviceType: 'bundle',
            billingInterval: 'month',
            durationDays: '30',
            price: '9',
            currency: 'GBP',
            capacityLimit: '12',
            streams: '3',
            serverClass: 'premium',
            visible: 'on',
            active: 'on'
        });
        const createdBundle = await createPlanRecord(bundle, null);
        const storedBundle = (await query('SELECT * FROM plans WHERE id=$1', [createdBundle.id])).rows[0];
        assert(storedBundle.service_type === 'bundle', 'Bundle plan did not persist its delivery type');

        const audit = await query("SELECT COUNT(*)::int count FROM audit_log WHERE action='admin.plan.create' AND entity_id=$1", [created.id]);
        assert(Number(audit.rows[0].count) === 1, 'Plan creation audit event missing');

        let duplicate = null;
        try { await createPlanRecord(monthly, null); } catch (error) { duplicate = error; }
        assert(duplicate?.code === '23505', 'Duplicate plan code was not rejected by the database');

        let invalidCurrency = false;
        try { planCreateInput({ ...monthly, code: 'valid-code', name: 'X', billingInterval: 'month', price: '1', currency: 'GB' }); }
        catch (_) { invalidCurrency = true; }
        assert(invalidCurrency, 'Invalid currency was accepted');

        let invalidPrice = false;
        try { planCreateInput({ code: 'valid-price-test', name: 'X', billingInterval: 'month', durationDays: '30', price: '-1', currency: 'GBP' }); }
        catch (_) { invalidPrice = true; }
        assert(invalidPrice, 'Negative price was accepted');

        console.log('plan create commerce smoke: ok');
    } finally {
        await cleanup();
        await getPool().end();
    }
}

main().catch(async error => {
    console.error(error);
    try { await cleanup(); } catch (_) {}
    try { await getPool().end(); } catch (_) {}
    process.exit(1);
});
