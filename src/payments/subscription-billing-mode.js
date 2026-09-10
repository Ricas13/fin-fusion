'use strict';

const BILLING_MODES=Object.freeze({SUBSCRIPTION:'subscription',PAYMENT:'payment',MANUAL:'manual'});
const PROVIDER_RECURRING_SOURCES=new Set(['stripe','paypal']);

function normalize(value){
  const mode=String(value||'').trim().toLowerCase();
  return Object.values(BILLING_MODES).includes(mode)?mode:null;
}

function modeFor(row){
  return normalize(row?.billing_mode);
}

function providerIdentityContradictsRecurring(row){
  const source=String(row?.source||'').trim().toLowerCase();
  const providerId=String(row?.provider_subscription_id||'').trim();
  // A Stripe PaymentIntent is a one-off payment resource, never a Stripe
  // Subscription. Treat this explicit resource-family contradiction as
  // non-recurring even if historical local metadata says otherwise.
  return source==='stripe'&&/^pi_/i.test(providerId);
}

function recurringProvider(row){
  const source=String(row?.source||'').trim().toLowerCase();
  if(modeFor(row)!==BILLING_MODES.SUBSCRIPTION||!PROVIDER_RECURRING_SOURCES.has(source))return null;
  if(providerIdentityContradictsRecurring(row))return null;
  return source;
}

function isRecurring(row){return Boolean(recurringProvider(row));}

function currencyOf(row){
  return String(row?.currency_snapshot||row?.currency||'').trim().toUpperCase();
}

function sameCurrency(a,b){
  const left=currencyOf(a),right=currencyOf(b);
  return Boolean(left&&right&&left===right);
}

module.exports={BILLING_MODES,PROVIDER_RECURRING_SOURCES,normalize,modeFor,providerIdentityContradictsRecurring,recurringProvider,isRecurring,currencyOf,sameCurrency};
