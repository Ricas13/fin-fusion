'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');
const registry = require('./registry');
const core = require('./provisioning-engine');
const compensation = require('./provisioning-compensation');

function randomPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

function safeError(error) {
  return String(error?.message || error || 'Unknown Jellyfin provisioning error')
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .slice(0, 1000);
}

function retryableCreateError(error) {
  return Boolean(error?.retryable)
    || ['JELLYFIN_TIMEOUT','JELLYFIN_REQUEST_FAILED'].includes(String(error?.code || ''));
}

function remoteNotFound(error) {
  return /\b404\b|not found/i.test(String(error?.message || error || ''));
}

async function preferredUsername(customerId) {
  const result = await query(`
    SELECT COALESCE(NULLIF(c.display_name,''),u.username,'user') AS username
    FROM customers c LEFT JOIN app_users u ON u.id=c.user_id
    WHERE c.id=$1
  `, [customerId]);
  if (!result.rowCount) throw new Error('Customer not found');
  return String(result.rows[0].username || 'user').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'user';
}

async function remoteUsers(serverId) {
  const users = await registry.request(serverId, '/Users');
  if (!Array.isArray(users)) throw new Error('Jellyfin did not return a valid user list');
  return users;
}

async function reservedNames(serverId, excludeIntentId = null) {
  const result = await query(`
    SELECT username FROM jellyfin_account_creation_intents
    WHERE server_id=$1 AND ($2::uuid IS NULL OR id<>$2::uuid)
  `, [serverId, excludeIntentId]);
  return result.rows.map(row => String(row.username || '').toLowerCase()).filter(Boolean);
}

async function takenNames(serverId, excludeIntentId = null) {
  const users = await remoteUsers(serverId);
  const names = new Set(users.map(user => String(user?.Name || '').toLowerCase()).filter(Boolean));
  for (const name of await reservedNames(serverId, excludeIntentId)) names.add(name);
  return { users, names };
}

function chooseCandidate(preferred, names) {
  const base = String(preferred || 'user').slice(0, 40) || 'user';
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 0; i < 40; i += 1) {
    const suffix = crypto.randomInt(1000, 10000);
    const candidate = `${base.slice(0, 35)}${suffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('Unable to generate a unique Jellyfin username');
}

async function findRemoteByName(serverId, username) {
  const users = await remoteUsers(serverId);
  const wanted = String(username || '').toLowerCase();
  const matches = users.filter(user => String(user?.Name || '').toLowerCase() === wanted);
  if (matches.length > 1) throw new Error(`Multiple Jellyfin users unexpectedly match ${username}`);
  return matches[0] || null;
}

async function findRemoteById(serverId, userId) {
  if (!userId) return null;
  try {
    const user = await registry.request(serverId, `/Users/${encodeURIComponent(userId)}`);
    return user?.Id ? user : null;
  } catch (error) {
    if (remoteNotFound(error)) return null;
    throw error;
  }
}

async function loadIntent(customerId, serverId) {
  const result = await query(`
    SELECT * FROM jellyfin_account_creation_intents
    WHERE customer_id=$1 AND server_id=$2
  `, [customerId, serverId]);
  return result.rows[0] || null;
}

async function setIntent(intentId, values = {}) {
  const result = await query(`
    UPDATE jellyfin_account_creation_intents
    SET status=COALESCE($2,status),
        username=COALESCE($3,username),
        remote_user_id=CASE WHEN $4::boolean THEN $5 ELSE remote_user_id END,
        attempted_at=CASE WHEN $6::boolean THEN NOW() ELSE attempted_at END,
        last_error=$7,
        updated_at=NOW()
    WHERE id=$1
    RETURNING *
  `, [
    intentId,
    values.status || null,
    values.username || null,
    Object.prototype.hasOwnProperty.call(values, 'remoteUserId'),
    values.remoteUserId || null,
    Boolean(values.attempted),
    values.lastError == null ? null : safeError(values.lastError)
  ]);
  return result.rows[0] || null;
}

async function deleteIntent(intentId) {
  if (intentId) await query('DELETE FROM jellyfin_account_creation_intents WHERE id=$1', [intentId]);
}

async function prepareIntent(customerId, serverId, preferred, requireExactUsername) {
  let existing = await loadIntent(customerId, serverId);
  if (existing) return existing;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { names } = await takenNames(serverId);
    if (requireExactUsername && names.has(preferred.toLowerCase())) {
      const error = new Error(`Username ${preferred} already exists on target Jellyfin server`);
      error.code = 'TARGET_USERNAME_EXISTS';
      throw error;
    }
    const username = requireExactUsername ? preferred : chooseCandidate(preferred, names);
    try {
      const inserted = await query(`
        INSERT INTO jellyfin_account_creation_intents(customer_id,server_id,username,require_exact_username,status)
        VALUES($1,$2,$3,$4,'prepared')
        ON CONFLICT(customer_id,server_id) DO NOTHING
        RETURNING *
      `, [customerId, serverId, username, Boolean(requireExactUsername)]);
      if (inserted.rowCount) return inserted.rows[0];
      existing = await loadIntent(customerId, serverId);
      if (existing) return existing;
    } catch (error) {
      if (String(error?.code || '') !== '23505') throw error;
      if (requireExactUsername) {
        const conflict = new Error(`Username ${preferred} is already reserved for another Jellyfin account creation`);
        conflict.code = 'TARGET_USERNAME_EXISTS';
        throw conflict;
      }
    }
  }
  throw new Error('Unable to reserve a Jellyfin username for account creation');
}

async function refreshPreparedIntent(intent, preferred) {
  const { names } = await takenNames(intent.server_id, intent.id);
  if (!names.has(String(intent.username).toLowerCase())) return intent;
  if (intent.require_exact_username) {
    const error = new Error(`Username ${preferred} already exists on target Jellyfin server`);
    error.code = 'TARGET_USERNAME_EXISTS';
    throw error;
  }
  const username = chooseCandidate(preferred, names);
  try {
    return await setIntent(intent.id, { status: 'prepared', username, remoteUserId: null });
  } catch (error) {
    if (String(error?.code || '') !== '23505') throw error;
    return refreshPreparedIntent(await loadIntent(intent.customer_id, intent.server_id), preferred);
  }
}

async function recoverIntent(intent) {
  if (!intent) return null;
  if (intent.remote_user_id) {
    const byId = await findRemoteById(intent.server_id, intent.remote_user_id);
    if (byId) return byId;
    intent = await setIntent(intent.id, { status: 'prepared', remoteUserId: null });
  }
  if (['attempting','uncertain'].includes(String(intent.status))) {
    const found = await findRemoteByName(intent.server_id, intent.username);
    if (found?.Id) {
      await setIntent(intent.id, { status: 'remote_created', remoteUserId: String(found.Id) });
      return found;
    }
    await setIntent(intent.id, { status: 'prepared', remoteUserId: null });
  }
  return null;
}

async function recoverAfterAmbiguousCreate(intent, originalError) {
  await setIntent(intent.id, { status: 'uncertain', lastError: originalError });
  try {
    const found = await findRemoteByName(intent.server_id, intent.username);
    if (!found?.Id) return null;
    await setIntent(intent.id, { status: 'remote_created', remoteUserId: String(found.Id), lastError: originalError });
    return found;
  } catch (verificationError) {
    originalError.recoveryError = verificationError;
    throw originalError;
  }
}

async function createRemote(intent, bootstrapPassword) {
  await setIntent(intent.id, { status: 'attempting', attempted: true });
  let created;
  try {
    created = await registry.request(intent.server_id, '/Users/New', {
      method: 'POST',
      body: { Name: intent.username, Password: bootstrapPassword }
    });
  } catch (error) {
    if (!retryableCreateError(error)) {
      await setIntent(intent.id, { status: 'prepared', remoteUserId: null, lastError: error });
      throw error;
    }
    const recovered = await recoverAfterAmbiguousCreate(intent, error);
    if (!recovered) throw error;
    return recovered;
  }

  if (!created?.Id) {
    const error = new Error('Jellyfin did not return a user ID after account creation');
    error.code = 'JELLYFIN_CREATE_RESULT_AMBIGUOUS';
    const recovered = await recoverAfterAmbiguousCreate(intent, error);
    if (!recovered) throw error;
    return recovered;
  }
  await setIntent(intent.id, { status: 'remote_created', remoteUserId: String(created.Id) });
  return created;
}

async function rollbackUnsafeRemote(intent, customerId, created, stage, originalError) {
  try {
    await compensation.removeCreatedUser({
      customerId,
      serverId: intent.server_id,
      userId: created.Id,
      stage,
      originalError
    });
    await deleteIntent(intent.id);
  } catch (cleanupError) {
    await setIntent(intent.id, { status: 'remote_created', remoteUserId: String(created.Id), lastError: cleanupError }).catch(() => {});
    throw cleanupError;
  }
}

async function createJellyfinAccount(customerId, server, effective, options = {}) {
  const preferred = String(options.preferredUsername || await preferredUsername(customerId)).slice(0, 40);
  let intent = await prepareIntent(customerId, server.id, preferred, Boolean(options.requireExactUsername));
  let created = await recoverIntent(intent);

  if (!created) {
    intent = await loadIntent(customerId, server.id);
    intent = await refreshPreparedIntent(intent, preferred);
    created = await createRemote(intent, options.bootstrapPassword || randomPassword());
  }

  intent = await loadIntent(customerId, server.id);
  if (!intent) throw new Error('Jellyfin account creation intent disappeared before persistence');
  if (!intent.remote_user_id && created?.Id) intent = await setIntent(intent.id, { status: 'remote_created', remoteUserId: String(created.Id) });

  const libraryAccess = await core.resolveLibraryAccessForServer(
    server.id,
    effective.unrestricted,
    effective.visibleNames,
    false
  );

  try {
    await registry.request(server.id, `/Users/${created.Id}/Policy`, {
      method: 'POST',
      body: core.policyBody(effective.technical, false, libraryAccess)
    });
  } catch (error) {
    await rollbackUnsafeRemote(intent, customerId, created, 'policy_apply', error);
    throw compensation.rolledBackError(
      'Jellyfin account creation could not be completed while applying access policy. The remote account was rolled back.',
      'JELLYFIN_POLICY_APPLY_FAILED',
      error
    );
  }

  let account;
  try {
    account = await transaction(async client => {
      const stored = await client.query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,last_policy_sync,is_primary)
        VALUES($1,$2,$3,$4,FALSE,NOW(),FALSE)
        ON CONFLICT(server_id,jellyfin_user_id) DO UPDATE SET
          customer_id=EXCLUDED.customer_id,
          jellyfin_username=EXCLUDED.jellyfin_username,
          disabled=FALSE,
          last_policy_sync=NOW(),
          updated_at=NOW()
        WHERE jellyfin_accounts.customer_id=EXCLUDED.customer_id
        RETURNING *
      `, [customerId, server.id, created.Id, intent.username]);
      if (!stored.rowCount) throw new Error('Remote Jellyfin account is already owned by another customer');
      await client.query('DELETE FROM jellyfin_account_creation_intents WHERE id=$1', [intent.id]);
      return stored.rows[0];
    });
  } catch (error) {
    // The remote account already has the desired policy. Keep it and its
    // durable intent so a database/network recovery can attach it later
    // instead of creating a duplicate remote user.
    await setIntent(intent.id, { status: 'remote_created', remoteUserId: String(created.Id), lastError: error }).catch(() => {});
    const wrapped = new Error('Jellyfin account was created safely but could not yet be persisted locally. Automatic reconciliation will retry without creating a duplicate remote user.');
    wrapped.code = 'JELLYFIN_ACCOUNT_PERSIST_RETRYABLE';
    wrapped.retryable = true;
    wrapped.cause = error;
    throw wrapped;
  }

  if (libraryAccess.missing.length) {
    const message = `Missing on server: ${libraryAccess.missing.join(', ')}`;
    await core.upsertReconciliationStatus(account.id, customerId, 'failed', message);
    throw new Error(`Jellyfin account created with a narrowed library set -- ${message}`);
  }
  await core.upsertReconciliationStatus(account.id, customerId, 'successful', null);
  if (options.makePrimary !== false) {
    await core.markPrimaryAccount(customerId, account.id);
    account.is_primary = true;
  }
  return account;
}

module.exports = {
  createJellyfinAccount,
  retryableCreateError,
  preferredUsername,
  loadIntent,
  findRemoteByName
};
