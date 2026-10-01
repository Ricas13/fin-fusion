'use strict';

const lifecycleState = require('./provider-lifecycle-state');
const lifecycleAdapters = require('./provider-lifecycle-adapters');
const refundAdapters = require('./provider-refund-adapters');
const incidents = require('./incidents');

function providerName(provider) {
  return lifecycleState.providerName(provider);
}

function normalizeState(provider, status) {
  return lifecycleState.normalizeStatus(provider, status);
}

function state(provider, status) {
  return {
    provider: providerName(provider),
    status: normalizeState(provider, status),
    healthy: lifecycleState.isHealthy(provider, status),
    waiting: lifecycleState.isWaiting(provider, status),
    terminal: lifecycleState.isTerminal(provider, status)
  };
}

function capabilities(provider) {
  const name = providerName(provider);
  return Object.freeze({
    provider: name,
    recurringLifecycle: name === 'stripe' || name === 'paypal',
    refunds: name === 'stripe' || name === 'paypal',
    oneTimeRemoteLookup: name === 'plisio'
  });
}

async function recurring(provider) {
  const name = providerName(provider);
  if (!capabilities(name).recurringLifecycle) {
    const error = new Error(`Recurring lifecycle is not supported for ${name}.`);
    error.code = 'PROVIDER_RECURRING_UNSUPPORTED';
    throw error;
  }
  return lifecycleAdapters.forProvider(name);
}

function refunds(provider) {
  return refundAdapters.forProvider(provider);
}

async function settlementIdentity(provider, providerReference) {
  const name = providerName(provider);
  const reference = String(providerReference || '').trim();
  if (!reference) {
    const error = new Error('Provider settlement reference is required.');
    error.code = 'PROVIDER_SETTLEMENT_REFERENCE_REQUIRED';
    throw error;
  }
  return incidents.identityFromProviderSubscription(name, reference);
}

function providerMissing(error) {
  return lifecycleAdapters.providerMissing(error);
}

function stripePeriod(subscription) {
  return lifecycleAdapters.stripePeriod(subscription);
}

function stripePriceId(subscription) {
  return lifecycleAdapters.stripePriceId(subscription);
}

module.exports = {
  providerName,
  normalizeState,
  state,
  capabilities,
  recurring,
  refunds,
  settlementIdentity,
  providerMissing,
  stripePeriod,
  stripePriceId
};
