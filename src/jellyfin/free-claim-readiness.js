'use strict';

const customerAccessState = require('../access/customer-access-state');

function noCapacity(error) {
  return /no eligible jellyfin server|no jellyfin server is currently available/i.test(String(error?.message || error || ''));
}

async function hasReadyFreeAccount(customerId) {
  const access = await customerAccessState.freeJellyfin(customerId, { includeBlocked: true });
  return access.state === customerAccessState.ACCESS_STATES.ACTIVE_READY;
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
