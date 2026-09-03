'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const frozenLegacyFixture = [
    ...Array.from({ length: LEGACY_MIGRATION_COUNT - 3 }, (_, index) => `${String(index + 100).padStart(3, '0')}_legacy_${index}.sql`),
    ...Object.values(GRANDFATHERED_LEGACY_PREFIX_COLLISIONS).flat()
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
assert.throws(
    () => validateMigrationIds([
        ...frozenLegacyFixture.slice(0, LEGACY_MIGRATION_COUNT - 1),
        '012_third_collision.sql'
    ]),
    /historical legacy migration prefix collisions changed/
);

const dir = path.join(__dirname, '..', 'db', 'migrations');
const result = validateMigrationIds(fs.readdirSync(dir));
console.log(`migration id smoke: ok (${result.legacy} frozen legacy, ${result.timestamped} timestamped)`);

module.exports = { validateMigrationIds, legacyPrefixCollisions, LEGACY_MIGRATION_COUNT, LEGACY_PATTERN, TIMESTAMP_PATTERN, GRANDFATHERED_LEGACY_PREFIX_COLLISIONS };
