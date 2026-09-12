'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, getPool } = require('../src/db');
const revenueIntegrity = require('../src/automation/revenue-integrity');

const suffix = crypto.randomBytes(5).toString('hex');
const createdCustomers = [];

async function createCustomer(label) {
    const result = await query(
        'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
        [`Legacy actorless ${label} ${suffix}`, `legacy-actorless-${label}-${suffix}@example.invalid`]
    );
    createdCustomers.push(result.rows[0].id);
    return result.rows[0].id;
}

async function insertHold({ customerId, holdType, createdAt, metadata = {} }) {
    const result = await query(`
        INSERT INTO customer_access_holds(
            customer_id,hold_type,source_key,reason,metadata,actor_user_id,created_at
        ) VALUES($1,$2,'admin','legacy actor attribution smoke',$3::jsonb,NULL,$4::timestamptz)
        RETURNING id
    `, [customerId, holdType, JSON.stringify(metadata), createdAt]);
    return result.rows[0].id;
}

async function main() {
    const migration = fs.readFileSync(
        path.join(__dirname, '..', 'db/migrations/20260912113000_reclassify_legacy_actorless_admin_holds.sql'),
        'utf8'
    );

    assert.doesNotMatch(migration, /\bSET\s+hold_type\s*=/i, 'repair migration must not rewrite hold_type');
    assert.doesNotMatch(migration, /\bSET\s+source_key\s*=/i, 'repair migration must not rewrite source_key');
    assert.match(migration, /2026-09-12 08:32:17\+00/, 'repair migration must use the exact actor-enforcement cutoff');
    assert.match(migration, /legacyActorlessAdmin/, 'repair migration must add the explicit historical marker');
    assert.match(migration, /legacyActorRepair/, 'repair migration must version the explicit historical marker');

    const marker = {
        legacyActorlessAdmin: true,
        legacyActorRepair: revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR
    };

    const markedCustomer = await createCustomer('marked-old');
    const markedDisabled = await insertHold({
        customerId: markedCustomer,
        holdType: 'admin_disabled',
        createdAt: '2026-09-11T12:00:00.000Z',
        metadata: marker
    });
    const markedSuspended = await insertHold({
        customerId: markedCustomer,
        holdType: 'admin_suspended',
        createdAt: '2026-09-11T12:01:00.000Z',
        metadata: marker
    });

    const unmarkedCustomer = await createCustomer('unmarked-old');
    const unmarkedOld = await insertHold({
        customerId: unmarkedCustomer,
        holdType: 'admin_disabled',
        createdAt: '2026-09-11T13:00:00.000Z'
    });

    const postCutoffCustomer = await createCustomer('marked-new');
    const markedNew = await insertHold({
        customerId: postCutoffCustomer,
        holdType: 'admin_suspended',
        createdAt: '2026-09-12T08:32:18.000Z',
        metadata: marker
    });

    const wrongMarkerCustomer = await createCustomer('wrong-marker');
    const wrongMarkerOld = await insertHold({
        customerId: wrongMarkerCustomer,
        holdType: 'admin_hold',
        createdAt: '2026-09-11T14:00:00.000Z',
        metadata: { legacyActorlessAdmin: true, legacyActorRepair: 'wrong-repair' }
    });

    const findings = await query(
        revenueIntegrity.ACTORLESS_ADMIN_HOLDS_SQL,
        [revenueIntegrity.ADMIN_ACTOR_ENFORCED_AT, revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR]
    );
    const findingIds = new Set(findings.rows.map(row => String(row.id)));

    assert(!findingIds.has(String(markedDisabled)), 'marked pre-enforcement disabled hold must be exempt');
    assert(!findingIds.has(String(markedSuspended)), 'marked pre-enforcement suspended hold must be exempt');
    assert(findingIds.has(String(unmarkedOld)), 'unmarked pre-enforcement hold must still alert');
    assert(findingIds.has(String(markedNew)), 'post-enforcement actorless hold must still alert even with marker');
    assert(findingIds.has(String(wrongMarkerOld)), 'wrong repair marker must not suppress an actorless hold');

    const preserved = await query(`
        SELECT hold_type,source_key,released_at,actor_user_id
        FROM customer_access_holds
        WHERE customer_id=$1
        ORDER BY hold_type
    `, [markedCustomer]);
    assert.deepStrictEqual(
        preserved.rows.map(row => row.hold_type).sort(),
        ['admin_disabled', 'admin_suspended'],
        'historical dual authorities must retain their exact hold types'
    );
    assert(preserved.rows.every(row => row.source_key === 'admin'), 'historical holds must retain source_key=admin');
    assert(preserved.rows.every(row => row.released_at === null), 'repair marker must not release historical holds');
    assert(preserved.rows.every(row => row.actor_user_id === null), 'repair must not fabricate an administrator actor');

    const blocked = await query(`
        SELECT EXISTS(
            SELECT 1 FROM customer_access_holds
            WHERE customer_id=$1 AND released_at IS NULL
        ) AS blocked
    `, [markedCustomer]);
    assert.strictEqual(blocked.rows[0].blocked, true, 'marked historical holds must continue blocking access');

    console.log('legacy actorless admin holds DB smoke: ok');
}

main().finally(async () => {
    for (const customerId of createdCustomers.reverse()) {
        await query('DELETE FROM customer_access_holds WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
    }
    await getPool().end();
}).catch((error) => {
    console.error('legacy actorless admin holds DB smoke failed:', error);
    process.exit(1);
});
