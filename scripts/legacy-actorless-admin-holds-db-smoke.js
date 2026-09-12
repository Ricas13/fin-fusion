'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db');
const revenueIntegrity = require('../src/automation/revenue-integrity');
const { releaseHold, isBlocked } = require('../src/entitlements/access-holds');

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
        /COALESCE\(jsonb_typeof\(h\.metadata\),''\)='object'/,
        'watchdog must fail open to an alert when metadata shape is absent or malformed'
    );
    assert.match(
        revenueIntegrity.ACTORLESS_ADMIN_HOLDS_SQL,
        /NULLIF\(h\.metadata->>'legacyActorMarkedAt',''\) IS NOT NULL/,
        'watchdog must require the complete migration marker before suppressing a historical finding'
    );
    assert.match(
        revenueIntegrity.ACTORLESS_ADMIN_HOLDS_SQL,
        /EXISTS\s*\(\s*SELECT 1\s*FROM audit_log a/i,
        'watchdog suppression must require durable audit evidence from the repair migration'
    );
    assert.match(
        revenueIntegrity.ACTORLESS_ADMIN_HOLDS_SQL,
        /a\.metadata->>'holdId'=h\.id::text/,
        'watchdog audit evidence must be tied to the exact hold'
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

        const forgedMarkerCustomer = await createCustomer(client, 'metadata-only-marker');
        const forgedMarker = await insertHold(client, {
            customerId: forgedMarkerCustomer,
            holdType: 'admin_disabled',
            createdAt: '2026-09-11T12:30:00.000Z',
            metadata: {
                legacyActorlessAdmin: true,
                legacyActorRepair: revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR,
                legacyActorMarkedAt: '2026-09-12T09:00:00.000Z'
            }
        });

        const incompleteMarkerCustomer = await createCustomer(client, 'incomplete-marker');
        const incompleteMarkerOld = await insertHold(client, {
            customerId: incompleteMarkerCustomer,
            holdType: 'admin_suspended',
            createdAt: '2026-09-11T13:00:00.000Z',
            metadata: {
                legacyActorlessAdmin: true,
                legacyActorRepair: revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR
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
                legacyActorRepair: revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR,
                legacyActorMarkedAt: '2026-09-12T09:00:00.000Z'
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
        assert(eligibleRows.rows.every(row => Boolean(row.metadata?.legacyActorMarkedAt)), 'eligible historical holds must receive a marker timestamp');
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

        const forgedMarkerAfter = await client.query('SELECT metadata FROM customer_access_holds WHERE id=$1', [forgedMarker]);
        assert.strictEqual(forgedMarkerAfter.rows[0].metadata.legacyActorMarkedAt, '2026-09-12T09:00:00.000Z', 'repair must not rewrite a pre-existing complete marker');
        const incompleteMarkerAfter = await client.query('SELECT metadata FROM customer_access_holds WHERE id=$1', [incompleteMarkerOld]);
        assert.strictEqual(incompleteMarkerAfter.rows[0].metadata.legacyActorMarkedAt, undefined, 'repair must not complete a pre-existing ambiguous marker');
        const wrongMarkerAfter = await client.query('SELECT metadata FROM customer_access_holds WHERE id=$1', [wrongMarkerOld]);
        assert.strictEqual(wrongMarkerAfter.rows[0].metadata.legacyActorRepair, 'wrong-repair', 'repair must not overwrite ambiguous pre-existing repair metadata');
        const malformedAfter = await client.query('SELECT metadata FROM customer_access_holds WHERE id=$1', [malformedMetadataOld]);
        assert(Array.isArray(malformedAfter.rows[0].metadata), 'repair must not normalize non-object historical metadata');

        const findings = await client.query(
            revenueIntegrity.ACTORLESS_ADMIN_HOLDS_SQL,
            [revenueIntegrity.ADMIN_ACTOR_ENFORCED_AT, revenueIntegrity.LEGACY_ACTORLESS_ADMIN_REPAIR]
        );
        const findingIds = new Set(findings.rows.map(row => String(row.id)));

        assert(!findingIds.has(String(eligibleDisabled)), 'migration-marked pre-enforcement disabled hold with audit evidence must be exempt');
        assert(!findingIds.has(String(eligibleSuspended)), 'migration-marked pre-enforcement suspended hold with audit evidence must be exempt');
        assert(findingIds.has(String(forgedMarker)), 'metadata-only marker without migration audit evidence must still alert');
        assert(findingIds.has(String(incompleteMarkerOld)), 'incomplete pre-enforcement marker must still alert');
        assert(findingIds.has(String(wrongMarkerOld)), 'ambiguous/wrong repair marker must still alert');
        assert(findingIds.has(String(malformedMetadataOld)), 'non-object metadata must never qualify for historical suppression');
        assert(findingIds.has(String(postCutoff)), 'post-enforcement actorless hold must still alert');
        assert(findingIds.has(String(exactCutoff)), 'hold created exactly at enforcement cutoff must still alert even with a complete marker');

        assert.strictEqual(await isBlocked(eligibleCustomer, client), true, 'marked historical holds must continue blocking access');
        const disabledReleased = await releaseHold({
            customerId: eligibleCustomer,
            type: 'admin_disabled',
            sourceKey: 'admin',
            resolutionReason: 'regression-test release'
        }, client);
        assert.strictEqual(disabledReleased, 1, 'targeted admin_disabled release must still find the historical hold by its original identity');
        assert.strictEqual(await isBlocked(eligibleCustomer, client), true, 'remaining admin_suspended hold must continue blocking access');
        const suspendedReleased = await releaseHold({
            customerId: eligibleCustomer,
            type: 'admin_suspended',
            sourceKey: 'admin',
            resolutionReason: 'regression-test release'
        }, client);
        assert.strictEqual(suspendedReleased, 1, 'targeted admin_suspended release must still find the historical hold by its original identity');
        assert.strictEqual(await isBlocked(eligibleCustomer, client), false, 'customer must unblock only after both original authorities are released');

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
