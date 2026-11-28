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
    console.warn('Unpaid activation is pending.', {
      customerId, subscriptionId, code: pendingCode, error: cause?.message
    });
    const error = new Error(pendingMessage);
    error.code = pendingCode;
    // Curated by the caller, so the customer may read it.
    error.expose = true;
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
  let outcome;
  try {
    outcome = await rollback(customerId, subscriptionId, { ...rollbackOptions, reason });
  } catch (error) {
    if (isLockTimeout(error)) return pending(error);
    throw error;
  }
  if (outcome?.rolledBack === false) {
    // The rollback re-checked under the lock and changed nothing.
    const readyNow = await verify(customerId, subscriptionId);
    if (readyNow) return { ready: readyNow, reconcileError: null };
    // A replaced subscription is gone either way; anything else is still live.
    if (outcome.reason !== 'not_current') return pending(reconcileError);
  }

  // The exposed message skips the customer-error reference log, so record the
  // underlying cause here.
  console.error('Unpaid activation failed.', {
    customerId, subscriptionId, code: failureCode, error: reconcileError?.message || missingReason
  });
  const error = new Error(failureMessage);
  error.code = failureCode;
  error.expose = true;
  error.cause = reconcileError || undefined;
  throw error;
}

module.exports = { activateOrRollback };
