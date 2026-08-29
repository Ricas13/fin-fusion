'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LEGACY_MIGRATION_COUNT = 60;
const LEGACY_PATTERN = /^\d{3}_[a-z0-9][a-z0-9_]*\.sql$/;
const TIMESTAMP_PATTERN = /^(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/;

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

// Prove the guard rejects the exact future-collision class it is meant to stop.
assert.throws(
    () => validateMigrationIds([
        ...Array.from({ length: LEGACY_MIGRATION_COUNT }, (_, index) => `${String(index).padStart(3, '0')}_legacy_${index}.sql`),
        '20260829170000_first.sql',
        '20260829170000_second.sql'
    ]),
    /duplicate migration timestamp/
);
assert.throws(
    () => validateMigrationIds([
        ...Array.from({ length: LEGACY_MIGRATION_COUNT }, (_, index) => `${String(index).padStart(3, '0')}_legacy_${index}.sql`),
        '109_new_legacy_style.sql'
    ]),
    /historical migrations are frozen/
);

const dir = path.join(__dirname, '..', 'db', 'migrations');
const result = validateMigrationIds(fs.readdirSync(dir));
console.log(`migration id smoke: ok (${result.legacy} frozen legacy, ${result.timestamped} timestamped)`);

module.exports = { validateMigrationIds, LEGACY_MIGRATION_COUNT, LEGACY_PATTERN, TIMESTAMP_PATTERN };
