'use strict';

const { query } = require('../db');

function noCapacity(error) {
  return /no eligible jellyfin server|no jellyfin server is currently available/i.test(String(error?.message || error || ''));
}

async function hasReadyFreeAccount(customerId) {
  const result = await query(`
    SELECT 1
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.customer_id=$1
      AND ja.account_purpose='jellyfin'
      AND ja.access_lane='free'
      AND ja.disabled=FALSE
      AND js.enabled=TRUE
      AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
    LIMIT 1
  `, [customerId]);
  return result.rowCount > 0;
}

async function ensureFreeClaimReady(customerId) {
  if (await hasReadyFreeAccount(customerId)) {
    return { ready: true, attempts: 0, error: null };
  }

  const error = new Error('Free Access is not active because no enabled Free Server account exists. No deployment-pending Free claim should be retained.');
  error.code = 'FREE_CLAIM_ACCOUNT_MISSING';
  return { ready: false, attempts: 0, error };
}

module.exports = { hasReadyFreeAccount, ensureFreeClaimReady, noCapacity };
