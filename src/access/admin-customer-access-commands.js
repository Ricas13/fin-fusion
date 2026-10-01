'use strict';

const manualAssignment = require('../jellyfin/manual-assignment');
const permanentAccess = require('../entitlements/permanent-access');

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

async function assignServer(customerId, serverId, { actorUserId = null } = {}) {
  const normalizedServerId = clean(serverId, 80);
  if (!normalizedServerId) throw new Error('Choose a Jellyfin server.');
  return manualAssignment.assign(customerId, normalizedServerId, { actorUserId });
}

async function permanentAccessStatus(customerId) {
  return permanentAccess.status(customerId);
}

async function setPermanentAccess(customerId, { action, reason = '', actorUserId = null } = {}) {
  const normalizedAction = clean(action, 20).toLowerCase();
  const normalizedReason = clean(reason, 500);

  if (normalizedAction === 'enable') {
    await permanentAccess.enable(customerId, {
      actorUserId,
      reason: normalizedReason
    });
    return { enabled: true };
  }

  if (normalizedAction === 'revoke') {
    await permanentAccess.revoke(customerId, {
      actorUserId,
      reason: normalizedReason
    });
    return { enabled: false };
  }

  throw new Error('Choose a valid permanent-access action.');
}

module.exports = {
  assignServer,
  permanentAccessStatus,
  setPermanentAccess
};
