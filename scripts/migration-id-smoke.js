'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const migrationEpochs = require('./migration-epochs');

const LEGACY_MIGRATION_COUNT = 60;
const LEGACY_PATTERN = /^(\d{3})_[a-z0-9][a-z0-9_]*\.sql$/;
const TIMESTAMP_PATTERN = /^(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/;
const GRANDFATHERED_LEGACY_PREFIX_COLLISIONS = Object.freeze({
    '012': ['012_admin_dashboard_layout.sql', '012_support_tickets.sql'],
    '017': ['017_stremio_install_credential_recovery.sql', '017_stremio_managed_playback_lifecycle.sql'],
    '045': ['045_parallel_free_jellyfin_access.sql', '045_service_scoped_recurring_constraint.sql']
});

function legacyPrefixCollisions(files) {
    const groups = new Map();
    for (const file of files.filter(file => file.endsWith('.sql')).sort()) {
        const match = LEGACY_PATTERN.exec(file);
        if (!match) continue;
        const prefix = match[1];
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix).push(file);
    }
    return Object.fromEntries([...groups.entries()].filter(([, names]) => names.length > 1));
}

function validateMigrationIds(files) {
    const sqlFiles = files.filter(file => file.endsWith('.sql')).sort();
    const legacy = sqlFiles.filter(file => LEGACY_PATTERN.test(file));
    const unknown = sqlFiles.filter(file => !LEGACY_PATTERN.test(file) && !TIMESTAMP_PATTERN.test(file));
    assert.strictEqual(unknown.length, 0, `migration filenames must use the documented timestamp convention: ${unknown.join(', ')}`);
    assert.strictEqual(
        legacy.length,
        LEGACY_MIGRATION_COUNT,
        `historical migrations are frozen (${LEGACY_MIGRATION_COUNT} legacy files expected); future migrations must use YYYYMMDDHHMMSS_description.sql`
    );

    // Historical filenames are schema_migrations identities and therefore must
    // never be renamed merely to clean up old numeric-prefix collisions. Freeze
    // the three known collisions exactly and reject any new or changed group.
    assert.deepStrictEqual(
        legacyPrefixCollisions(sqlFiles),
        GRANDFATHERED_LEGACY_PREFIX_COLLISIONS,
        'historical legacy migration prefix collisions changed; do not add/rename numeric migrations—use a unique timestamp migration'
    );

    const seen = new Map();
    for (const file of sqlFiles) {
        const match = TIMESTAMP_PATTERN.exec(file);
        if (!match) continue;
        const id = match[1];
        assert(!seen.has(id), `duplicate migration timestamp ${id}: ${seen.get(id)} and ${file}`);
        seen.set(id, file);
    }
    return { legacy: legacy.length, timestamped: seen.size };
}

const frozenCollisionFiles = Object.values(GRANDFATHERED_LEGACY_PREFIX_COLLISIONS).flat();
const frozenLegacyFixture = [
    ...Array.from({ length: LEGACY_MIGRATION_COUNT - frozenCollisionFiles.length }, (_, index) => `${String(index + 100).padStart(3, '0')}_legacy_${index}.sql`),
    ...frozenCollisionFiles
];

// Prove the guard rejects both future timestamp collisions and attempts to add
// another old-style numeric migration/prefix collision.
assert.throws(
    () => validateMigrationIds([
        ...frozenLegacyFixture,
        '20260829170000_first.sql',
        '20260829170000_second.sql'
    ]),
    /duplicate migration timestamp/
);
const alteredLegacyFixture = frozenLegacyFixture.filter(file => file !== '100_legacy_0.sql');
alteredLegacyFixture.push('012_third_collision.sql');
assert.throws(
    () => validateMigrationIds(alteredLegacyFixture),
    /historical legacy migration prefix collisions changed/
);

const dir = path.join(__dirname, '..', 'db', 'migrations');
const migrationFiles = fs.readdirSync(dir);
const result = validateMigrationIds(migrationFiles);
const epoch = migrationEpochs.validate(migrationFiles);
assert.strictEqual(migrationEpochs.classify(migrationEpochs.CURRENT_EPOCH.baselineFile), 'baseline');
assert.strictEqual(migrationEpochs.isFoldedIntoBaseline(migrationEpochs.CURRENT_EPOCH.baselineFile), false,
    'the baseline itself must never be classified as folded history');
assert.deepStrictEqual(
    migrationEpochs.CURRENT_EPOCH.foldedMigrations,
    [],
    'the v1 baseline has no independently recorded migrations that may be skipped'
);
assert.strictEqual(migrationEpochs.isFoldedIntoBaseline('001_remove_retired_product.sql'), false,
    'v1 companion migrations must still execute and be recorded');
assert.strictEqual(migrationEpochs.isFoldedIntoBaseline('002_add_runtime_session_store.sql'), false,
    'runtime session storage is not present in the v1 baseline and must still execute');
assert.strictEqual(migrationEpochs.isFoldedIntoBaseline('003_stremio_source_match_fallbacks.sql'), false,
    'later legacy-numbered migrations must still execute');
const representativeIncremental = migrationFiles.find(file => migrationEpochs.classify(file) === 'incremental');
assert(representativeIncremental && !migrationEpochs.isFoldedIntoBaseline(representativeIncremental),
    'timestamped incremental migrations must still execute after the baseline');
assert.strictEqual(epoch.frozenLegacy, result.legacy - 1,
    'epoch contract must classify the baseline separately from the frozen legacy migration population');
assert.strictEqual(epoch.incremental, result.timestamped,
    'every timestamp migration must belong to the current incremental epoch');
console.log(`migration id smoke: ok (${result.legacy} frozen legacy, ${result.timestamped} timestamped; epoch=${epoch.id})`);

module.exports = { validateMigrationIds, legacyPrefixCollisions, LEGACY_MIGRATION_COUNT, LEGACY_PATTERN, TIMESTAMP_PATTERN, GRANDFATHERED_LEGACY_PREFIX_COLLISIONS };
