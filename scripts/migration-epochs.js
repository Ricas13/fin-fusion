'use strict';

const CURRENT_EPOCH = Object.freeze({
  id: 'baseline-v1-20260818',
  baselineFile: '000_database_baseline.sql',
  baselineCommit: '70d8688dcdf91fc78f1a96e84c0364962bc1b207',
  foldedMigrations: Object.freeze([]),
  legacyBridgeCommit: 'b39ca004b4bd24ebc6dbdf4546d2bb6b4111b95b'
});

const LEGACY_PATTERN = /^\d{3}_[a-z0-9][a-z0-9_]*\.sql$/;
const TIMESTAMP_PATTERN = /^\d{14}_[a-z0-9][a-z0-9_]*\.sql$/;

function classify(filename) {
  const name = String(filename || '');
  if (name === CURRENT_EPOCH.baselineFile) return 'baseline';
  if (LEGACY_PATTERN.test(name)) return 'frozen_legacy';
  if (TIMESTAMP_PATTERN.test(name)) return 'incremental';
  return 'unknown';
}

function isFoldedIntoBaseline(filename) {
  return CURRENT_EPOCH.foldedMigrations.includes(String(filename || ''));
}

function validate(files) {
  const sqlFiles = (Array.isArray(files) ? files : []).filter(file => String(file).endsWith('.sql')).sort();
  const baselines = sqlFiles.filter(file => classify(file) === 'baseline');
  if (baselines.length !== 1) {
    throw new Error(`Migration epoch ${CURRENT_EPOCH.id} requires exactly one ${CURRENT_EPOCH.baselineFile}; found ${baselines.length}.`);
  }
  if (sqlFiles[0] !== CURRENT_EPOCH.baselineFile) {
    throw new Error(`Current baseline ${CURRENT_EPOCH.baselineFile} must sort before every incremental migration.`);
  }
  const unknown = sqlFiles.filter(file => classify(file) === 'unknown');
  if (unknown.length) {
    throw new Error(`Migration epoch contains unclassified SQL files: ${unknown.join(', ')}`);
  }
  const missingFolded = CURRENT_EPOCH.foldedMigrations.filter(file => !sqlFiles.includes(file));
  if (missingFolded.length) {
    throw new Error(`Migration epoch ${CURRENT_EPOCH.id} is missing folded migration(s): ${missingFolded.join(', ')}`);
  }
  const invalidFolded = CURRENT_EPOCH.foldedMigrations.filter(file => classify(file) !== 'frozen_legacy');
  if (invalidFolded.length) {
    throw new Error(`Folded migration identities must remain immutable legacy files: ${invalidFolded.join(', ')}`);
  }
  return {
    id: CURRENT_EPOCH.id,
    baselineFile: CURRENT_EPOCH.baselineFile,
    frozenLegacy: sqlFiles.filter(file => classify(file) === 'frozen_legacy').length,
    incremental: sqlFiles.filter(file => classify(file) === 'incremental').length
  };
}

module.exports = {
  CURRENT_EPOCH,
  LEGACY_PATTERN,
  TIMESTAMP_PATTERN,
  classify,
  isFoldedIntoBaseline,
  validate
};
