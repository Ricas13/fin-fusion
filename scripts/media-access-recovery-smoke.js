'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('db/migrations/20260913114500_media_access_recovery_profiles.sql');
const helpers = read('src/jellyfin/provisioning-helpers.js');
const recoverySource = read('src/jellyfin/media-access-recovery.js');

const previousKey = process.env.DATA_ENCRYPTION_KEY;
process.env.DATA_ENCRYPTION_KEY = '11'.repeat(32);
const recovery = require('../src/jellyfin/media-access-recovery');
const crypto = require('../src/crypto');

try {
  assert.strictEqual(recovery.normalizeService('emby'), 'emby');
  assert.strictEqual(recovery.normalizeService('anything-else'), 'jellyfin');
  assert.strictEqual(recovery.normalizeLane('free'), 'free');
  assert.strictEqual(recovery.normalizeLane('primary'), 'primary');

  const encrypted = recovery.encryptManagedPassword('managed-secret');
  assert(encrypted && encrypted !== 'managed-secret', 'managed passwords must never be stored as plaintext');
  assert.strictEqual(crypto.decryptString(encrypted), 'managed-secret', 'managed password escrow must round-trip with DATA_ENCRYPTION_KEY');

  assert(migration.includes('REFERENCES public.customers(id) ON DELETE CASCADE'),
    'hard customer deletion must purge recovery profiles through the customer foreign key');
  assert(migration.includes('IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id=OLD.customer_id) THEN'),
    'account-delete trigger must skip snapshotting during hard customer deletion cascades');
  assert(migration.includes("CHECK (service_type IN ('jellyfin','emby'))")
    && migration.includes("CHECK (access_lane IN ('primary','free'))"),
    'recovery identity must remain separated by media service and access lane');
  assert(migration.includes("IF OLD.account_purpose IS DISTINCT FROM 'jellyfin' THEN"),
    'Stremio/internal media accounts must not be captured by customer media recovery');

  assert(helpers.includes('recovery.recoveryForCreation(customerId, server, accessLane)'),
    'account recreation must load recovery state only after canonical placement chooses a server');
  assert(helpers.includes('preferredUsername: options.preferredUsername || saved.preferredUsername || undefined')
    && helpers.includes('bootstrapPassword: options.bootstrapPassword || saved.password || undefined'),
    'recreation must reuse recoverable username/password without bypassing caller overrides');
  assert(helpers.includes('if (saved.hasManagedPassword)')
    && helpers.includes('password_setup_required=FALSE,password_reset_required=FALSE'),
    'a successfully restored managed password must not force unnecessary password setup');
  assert(helpers.includes('const encryptedPassword = recovery.encryptManagedPassword(newPassword)')
    && helpers.indexOf('const encryptedPassword = recovery.encryptManagedPassword(newPassword)') < helpers.indexOf('core.setJellyfinPassword(customerId, accountId, newPassword)'),
    'encryption-key validation must happen before changing the remote password');

  assert(recoverySource.includes('Media access recovery bookkeeping failed after account recreation.')
    && recoverySource.includes('return false;'),
    'post-create recovery bookkeeping failure must not convert successful account creation into a duplicate-producing retry');

  console.log('media access recovery smoke: ok');
} finally {
  if (previousKey == null) delete process.env.DATA_ENCRYPTION_KEY;
  else process.env.DATA_ENCRYPTION_KEY = previousKey;
}
