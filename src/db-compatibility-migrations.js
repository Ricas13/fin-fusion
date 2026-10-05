'use strict';

// Additive, idempotent schema transitions that are safe for the previous web
// generation during a rolling deployment. These files live beside normal
// migrations so clean installs and deploy tooling execute them, but they are
// deliberately NOT written to schema_migrations. Readiness therefore remains
// anchored to the latest versioned migration shared by N and N-1.
const REPEATABLE_COMPATIBILITY_MIGRATIONS = new Set([
  '20261003113000_customer_media_location_assignment.sql',
  '20261005151000_same_plan_access_extensions.sql'
]);

function isRepeatableCompatibilityMigration(filename) {
  return REPEATABLE_COMPATIBILITY_MIGRATIONS.has(String(filename || ''));
}

function latestVersionedMigration(files) {
  return (Array.isArray(files) ? files : [])
    .filter(file => String(file).endsWith('.sql'))
    .filter(file => !isRepeatableCompatibilityMigration(file))
    .sort()
    .at(-1) || null;
}

module.exports = {
  REPEATABLE_COMPATIBILITY_MIGRATIONS,
  isRepeatableCompatibilityMigration,
  latestVersionedMigration
};
