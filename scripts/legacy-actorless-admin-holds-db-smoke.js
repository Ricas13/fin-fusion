'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db');
const revenueIntegrity = require('../src/automation/revenue-integrity');

const suffix = crypto.randomBytes(5).toString('hex');

function unwrapMigration(sql) {
    return sql
        .replace(/^\s*BEGIN\s*;\s*/i, '')
        .replace(/\s*COMMIT\s*;\s*$/i, '');
}

async function createCustomer(db, label) {
    const result = await db.query(
        'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
        [`Legacy actorless ${label} ${suffix}`, `legacy-actorless-${label}-${suffix}@example.invalid`]
    );
    return result.rows[0].id;
}

async function insertHold(db, { customerId, holdType, createdAt, metadata = {} }) {
    const result = await db.query(`
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
    assert.match(migration, /jsonb_typeof\(h\.metadata\)='object'/, 'repair migration must leave malformed/non-object metadata for manual review');
    assert.match(migration, /FOR UPDATE OF h/, 'repair migration must lock eligible holds before marking them');
    assert.match(migration, /m\.customer_id::text/, 'repair audit must explicitly cast customer UUIDs to audit_log.entity_id text');
    assert.match(migration, /NOT \(h\.metadata \? 'legacyActorRepair'\)/, 'repair migration must not overwrite ambiguous pre-existing repair keys');
    assert.match(
        revenueIntegrity.ACTORLESS_ADMIN_HOLDS_SQL,
        /COALESCE\(jsonb_typeof\(metadata\),''\)='object'/,
        'watchdog must fail open to an alert when metadata shape is absent or malformed'
    );

    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const eligibleCustomer = await createCustomer(client, 'eligible-old');
        const eligibleDisabled = await insertHold(client, {
            customerId: eligibleCustomer,
            holdType: 'admin_disabled',
            createdAt: '2026-09-11T12:00:00.000Z',
            metadata: { preserveMe: 'disabled' }
        });
        const eligibleSuspended = await insertHold(client, {
            customerId: eligibleCustomer,
            holdType: 'admin_suspended',
            createdAt: '2026-09-11T12:01:00.000Z',
            metadata: { preserveMe: 'suspended' }
        });

        const alreadyMarkedCustomer = await createCustomer(client, 'already-marked');
        const alreadyMarked = await insertHold(client, {
            customerId: alreadyMarkedCustomer,
            holdType: 'admin_disabled',
            createdAt: '2026-09-11T12:30:00.000Z',
            metadata: {
                legacyActorlessAdmin: true,
                legacyActorRepair: revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR,
                legacyActorMarkedAt: '2026-09-12T09:00:00.000Z'
            }
        });

        const wrongMarkerCustomer = await createCustomer(client, 'wrong-marker');
        const wrongMarkerOld = await insertHold(client, {
            customerId: wrongMarkerCustomer,
            holdType: 'admin_hold',
            createdAt: '2026-09-11T14:00:00.000Z',
            metadata: { legacyActorlessAdmin: true, legacyActorRepair: 'wrong-repair' }
        });

        const malformedMetadataCustomer = await createCustomer(client, 'malformed-metadata');
        const malformedMetadataOld = await insertHold(client, {
            customerId: malformedMetadataCustomer,
            holdType: 'admin_disabled',
            createdAt: '2026-09-11T15:00:00.000Z',
            metadata: [{ legacyActorlessAdmin: true, legacyActorRepair: revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR }]
        });

        const postCutoffCustomer = await createCustomer(client, 'post-cutoff');
        const postCutoff = await insertHold(client, {
            customerId: postCutoffCustomer,
            holdType: 'admin_suspended',
            createdAt: '2026-09-12T08:32:18.000Z'
        });

        const cutoffCustomer = await createCustomer(client, 'exact-cutoff');
        const exactCutoff = await insertHold(client, {
            customerId: cutoffCustomer,
            holdType: 'admin_disabled',
            createdAt: revenueIntegrity.ADMIN_ACTOR_ENFORCED_AT,
            metadata: {
                legacyActorlessAdmin: true,
                legacyActorRepair: revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR
            }
        });

        const migrationBody = unwrapMigration(migration);
        await client.query(migrationBody);
        // Applying the body twice in one rollback-only test transaction proves the
        // repair is idempotent and cannot append duplicate audit rows.
        await client.query(migrationBody);

        const eligibleRows = await client.query(`
            SELECT id,hold_type,source_key,released_at,actor_user_id,metadata
            FROM customer_access_holds
            WHERE customer_id=$1
            ORDER BY hold_type
        `, [eligibleCustomer]);
        assert.deepStrictEqual(
            eligibleRows.rows.map(row => row.hold_type).sort(),
            ['admin_disabled', 'admin_suspended'],
            'historical dual authorities must retain their exact hold types'
        );
        assert(eligibleRows.rows.every(row => row.source_key === 'admin'), 'historical holds must retain source_key=admin');
        assert(eligibleRows.rows.every(row => row.released_at === null), 'repair must not release historical holds');
        assert(eligibleRows.rows.every(row => row.actor_user_id === null), 'repair must not fabricate an administrator actor');
        assert(eligibleRows.rows.every(row => row.metadata?.legacyActorlessAdmin === true), 'eligible historical holds must receive the legacy marker');
        assert(eligibleRows.rows.every(row => row.metadata?.legacyActorRepair === revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR), 'eligible historical holds must receive the versioned repair marker');
        assert.deepStrictEqual(
            eligibleRows.rows.map(row => row.metadata?.preserveMe).sort(),
            ['disabled', 'suspended'],
            'repair must preserve unrelated historical metadata'
        );

        const audit = await client.query(`
            SELECT entity_id,metadata
            FROM audit_log
            WHERE action='customer.access_hold.legacy_actorless_marked'
              AND entity_type='customer'
              AND metadata->>'holdId' = ANY($1::text[])
            ORDER BY metadata->>'holdId'
        `, [[String(eligibleDisabled), String(eligibleSuspended)]]);
        assert.strictEqual(audit.rowCount, 2, 'eligible dual holds must produce exactly one audit event each even if migration body is replayed');
        assert(audit.rows.every(row => row.entity_id === String(eligibleCustomer)), 'repair audit entity_id must be the customer UUID serialized as text');
        assert(audit.rows.every(row => row.metadata?.preservedBlockingState === true), 'repair audit must record preserved blocking state');
        assert(audit.rows.every(row => row.metadata?.preservedAuthorityIdentity === true), 'repair audit must record preserved authority identity');

        const wrongMarkerAfter = await client.query('SELECT metadata FROM customer_access_holds WHERE id=$1', [wrongMarkerOld]);
        assert.strictEqual(wrongMarkerAfter.rows[0].metadata.legacyActorRepair, 'wrong-repair', 'repair must not overwrite ambiguous pre-existing repair metadata');
        const malformedAfter = await client.query('SELECT metadata FROM customer_access_holds WHERE id=$1', [malformedMetadataOld]);
        assert(Array.isArray(malformedAfter.rows[0].metadata), 'repair must not normalize non-object historical metadata');

        const findings = await client.query(
            revenueIntegrity.ACTORLESS_ADMIN_HOLDS_SQL,
            [revenueIntegrity.ADMIN_ACTOR_ENFORCED_AT, revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR]
        );
        const findingIds = new Set(findings.rows.map(row => String(row.id)));

        assert(!findingIds.has(String(eligibleDisabled)), 'migration-marked pre-enforcement disabled hold must be exempt');
        assert(!findingIds.has(String(eligibleSuspended)), 'migration-marked pre-enforcement suspended hold must be exempt');
        assert(!findingIds.has(String(alreadyMarked)), 'already-marked pre-enforcement hold must remain exempt');
        assert(findingIds.has(String(wrongMarkerOld)), 'ambiguous/wrong repair marker must still alert');
        assert(findingIds.has(String(malformedMetadataOld)), 'non-object metadata must never qualify for historical suppression');
        assert(findingIds.has(String(postCutoff)), 'post-enforcement actorless hold must still alert');
        assert(findingIds.has(String(exactCutoff)), 'hold created exactly at enforcement cutoff must still alert');

        const blocked = await client.query(`
            SELECT EXISTS(
                SELECT 1 FROM customer_access_holds
                WHERE customer_id=$1 AND released_at IS NULL
            ) AS blocked
        `, [eligibleCustomer]);
        assert.strictEqual(blocked.rows[0].blocked, true, 'marked historical holds must continue blocking access');

        await client.query('ROLLBACK');
        console.log('legacy actorless admin holds DB smoke: ok');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error('legacy actorless admin holds DB smoke failed:', error);
    process.exit(1);
});
