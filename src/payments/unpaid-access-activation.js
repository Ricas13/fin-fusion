'use strict';

async function activateOrRollback({
  customerId,
  subscriptionId,
  reconcile,
  verify,
  rollback,
  missingReason,
  failureMessage,
  failureCode,
  rollbackOptions = {}
}) {
  let reconcileError = null;
  try {
    await reconcile(customerId);
  } catch (error) {
    reconcileError = error;
  }

  const ready = await verify(customerId, subscriptionId);
  if (ready) return { ready, reconcileError: null };

  const reason = reconcileError?.message || missingReason;
  await rollback(customerId, subscriptionId, { ...rollbackOptions, reason });

  const error = new Error(failureMessage);
  error.code = failureCode;
  error.cause = reconcileError || undefined;
  throw error;
}

module.exports = { activateOrRollback };
