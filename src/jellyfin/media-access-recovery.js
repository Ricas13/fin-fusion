'use strict';

const { query, transaction } = require('../db');
const { encryptString, decryptString } = require('../crypto');

function normalizeService(value) {
  const service = String(value || 'jellyfin').toLowerCase();
  return service === 'emby' ? 'emby' : 'jellyfin';
}

function normalizeLane(value) {
  return String(value || 'primary').toLowerCase() === 'free' ? 'free' : 'primary';
}

async function serviceForServer(server) {
  if (server?.media_server_type) return normalizeService(server.media_server_type);
  if (!server?.id) return 'jellyfin';
  const found = await query(`SELECT COALESCE(media_server_type,'jellyfin') service_type FROM jellyfin_servers WHERE id=$1`, [server.id]);
  return normalizeService(found.rows[0]?.service_type);
}

async function recoveryForCreation(customerId, server, accessLane = 'primary') {
  const serviceType = await serviceForServer(server);
  const lane = normalizeLane(accessLane);
  const found = await query(`
    SELECT preferred_username,encrypted_password,selected_library_names,last_server_id,
           last_account_id,last_remote_user_id,removed_at,removal_reason
      FROM customer_media_access_recovery
     WHERE customer_id=$1 AND service_type=$2 AND access_lane=$3
     LIMIT 1
  `, [customerId, serviceType, lane]);
  if (!found.rowCount) return { serviceType, lane, found: false };

  const row = found.rows[0];
  let password = null;
  if (row.encrypted_password) {
    try {
      password = decryptString(row.encrypted_password);
    } catch (cause) {
      const error = new Error('Stored media recovery credential could not be decrypted. Account recreation was stopped before changing remote access.');
      error.code = 'MEDIA_RECOVERY_CREDENTIAL_DECRYPT_FAILED';
      error.cause = cause;
      throw error;
    }
  }
  return {
    serviceType,
    lane,
    found: true,
    preferredUsername: row.preferred_username || null,
    password,
    hasManagedPassword: Boolean(password),
    selectedLibraryNames: Array.isArray(row.selected_library_names) ? row.selected_library_names : null,
    previousServerId: row.last_server_id || null,
    previousAccountId: row.last_account_id || null,
    previousRemoteUserId: row.last_remote_user_id || null,
    removedAt: row.removed_at || null,
    removalReason: row.removal_reason || null
  };
}

function encryptManagedPassword(password) {
  return encryptString(password);
}

async function recordManagedPassword(customerId, accountId, encryptedPassword) {
  if (!encryptedPassword) throw new Error('Encrypted media credential is required');
  const found = await query(`
    SELECT ja.id,ja.customer_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,
           COALESCE(ja.access_lane,'primary') access_lane,
           COALESCE(js.media_server_type,'jellyfin') service_type,
           cls.selected_names
      FROM jellyfin_accounts ja
      JOIN jellyfin_servers js ON js.id=ja.server_id
      LEFT JOIN customer_jellyfin_library_selection cls
        ON cls.customer_id=ja.customer_id AND cls.jellyfin_account_id=ja.id
     WHERE ja.id=$1 AND ja.customer_id=$2 AND ja.account_purpose='jellyfin'
     LIMIT 1
  `, [accountId, customerId]);
  if (!found.rowCount) throw new Error('Media account not found while saving recovery credential');
  const row = found.rows[0];
  const serviceType = normalizeService(row.service_type);
  const lane = normalizeLane(row.access_lane);
  await query(`
    INSERT INTO customer_media_access_recovery(
      customer_id,service_type,access_lane,preferred_username,encrypted_password,password_saved_at,
      last_account_id,last_remote_user_id,last_server_id,selected_library_names,updated_at
    ) VALUES($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,NOW())
    ON CONFLICT(customer_id,service_type,access_lane) DO UPDATE SET
      preferred_username=EXCLUDED.preferred_username,
      encrypted_password=EXCLUDED.encrypted_password,
      password_saved_at=NOW(),
      last_account_id=EXCLUDED.last_account_id,
      last_remote_user_id=EXCLUDED.last_remote_user_id,
      last_server_id=EXCLUDED.last_server_id,
      selected_library_names=COALESCE(EXCLUDED.selected_library_names,customer_media_access_recovery.selected_library_names),
      updated_at=NOW()
  `, [customerId, serviceType, lane, row.jellyfin_username, encryptedPassword, row.id, row.jellyfin_user_id, row.server_id, row.selected_names || null]);
}

async function markRestored(customerId, account, recovery) {
  if (!recovery?.found || !account?.id) return false;
  try {
    await transaction(async db => {
      if (Array.isArray(recovery.selectedLibraryNames) && recovery.serviceType === 'jellyfin') {
        await db.query(`
          INSERT INTO customer_jellyfin_library_selection(customer_id,jellyfin_account_id,selected_names,updated_at)
          VALUES($1,$2,$3::text[],NOW())
          ON CONFLICT(customer_id,jellyfin_account_id)
          DO UPDATE SET selected_names=EXCLUDED.selected_names,updated_at=NOW()
        `, [customerId, account.id, recovery.selectedLibraryNames]);
      }
      await db.query(`
        UPDATE customer_media_access_recovery
           SET preferred_username=$4,
               last_account_id=$5,
               last_remote_user_id=$6,
               last_server_id=$7,
               removed_at=NULL,
               removal_reason=NULL,
               last_restored_at=NOW(),
               restore_count=restore_count+1,
               updated_at=NOW()
         WHERE customer_id=$1 AND service_type=$2 AND access_lane=$3
      `, [customerId, recovery.serviceType, recovery.lane, account.jellyfin_username || recovery.preferredUsername, account.id, account.jellyfin_user_id, account.server_id]);
    });
    return true;
  } catch (error) {
    // Account creation has already completed by this stage. Recovery metadata is
    // useful but must not turn a successful remote+local recreation into a
    // provisioning failure that could trigger duplicate retries.
    console.warn('Media access recovery bookkeeping failed after account recreation.', {
      customerId: String(customerId || '').slice(0, 100),
      accountId: String(account?.id || '').slice(0, 100),
      error: String(error?.message || error || 'unknown error').replace(/[\r\n\t]+/g, ' ').slice(0, 300)
    });
    return false;
  }
}

async function setRemovalReason(customerId, account, reason) {
  if (!account?.server_id) return;
  const serviceType = await serviceForServer({ id: account.server_id, media_server_type: account.media_server_type });
  const lane = normalizeLane(account.access_lane);
  await query(`
    UPDATE customer_media_access_recovery
       SET removal_reason=$4,
           removal_history=CASE
             WHEN jsonb_array_length(removal_history)>0 THEN
               jsonb_set(removal_history, ARRAY[(jsonb_array_length(removal_history)-1)::text],
                 (removal_history->(jsonb_array_length(removal_history)-1)) || jsonb_build_object('reason',$4))
             ELSE removal_history
           END,
           updated_at=NOW()
     WHERE customer_id=$1 AND service_type=$2 AND access_lane=$3
  `, [customerId, serviceType, lane, String(reason || 'Media account removed').slice(0, 500)]);
}

module.exports = {
  normalizeService,
  normalizeLane,
  serviceForServer,
  recoveryForCreation,
  encryptManagedPassword,
  recordManagedPassword,
  markRestored,
  setRemovalReason
};
