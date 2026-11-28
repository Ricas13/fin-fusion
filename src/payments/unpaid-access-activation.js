'use strict';

const { isLockTimeoutError } = require('../jellyfin/lock-errors');

async function activateOrRollback({
  customerId,
  subscriptionId,
  reconcile,
  verify,
  rollback,
  missingReason,
  failureMessage,
  failureCode,
  rollbackOptions = {},
  pendingMessage = 'Access setup has not finished yet.',
  pendingCode = 'UNPAID_ACTIVATION_PENDING',
  onPending = null,
  isLockTimeout = isLockTimeoutError
}) {
  // "Pending" means we could not find out whether this access works, so the
  // unpaid entitlement is kept and another reconciliation is requested.
  async function pending(cause) {
    if (onPending) {
      try {
        await onPending(customerId, subscriptionId);
      } catch (error) {
        console.error('Pending unpaid activation could not be queued for reconciliation.', {
          customerId, subscriptionId, error: error.message
        });
      }
    }
    const error = new Error(pendingMessage);
    error.code = pendingCode;
    error.retryable = true;
    error.cause = cause || undefined;
    throw error;
  }

  let reconcileError = null;
  try {
    await reconcile(customerId);
  } catch (error) {
    reconcileError = error;
  }

  const ready = await verify(customerId, subscriptionId);
  if (ready) return { ready, reconcileError: null };

  // The reconcile never ran. A missing account proves nothing.
  if (isLockTimeout(reconcileError)) return pending(reconcileError);

  const reason = reconcileError?.message || missingReason;
  try {
    await rollback(customerId, subscriptionId, { ...rollbackOptions, reason });
  } catch (error) {
    if (isLockTimeout(error)) return pending(error);
    throw error;
  }

  const error = new Error(failureMessage);
  error.code = failureCode;
  error.cause = reconcileError || undefined;
  throw error;
}

module.exports = { activateOrRollback };
