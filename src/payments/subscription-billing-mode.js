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

function recurringProvider(row){
  const source=String(row?.source||'').trim().toLowerCase();
  return modeFor(row)===BILLING_MODES.SUBSCRIPTION&&PROVIDER_RECURRING_SOURCES.has(source)?source:null;
}

function isRecurring(row){return Boolean(recurringProvider(row));}

function validRecurringProviderId(provider,id){
  const source=String(provider||'').trim().toLowerCase();
  const raw=String(id||'');
  const value=raw.trim();
  // Provider resource IDs are durable external identities. Accepting hidden
  // leading/trailing whitespace makes the local row look valid while later API
  // calls use a different literal ID and fail provider reconciliation.
  if(!value||raw!==value)return false;
  if(source==='stripe')return /^sub_/i.test(value);
  if(source==='paypal')return /^I-/i.test(value);
  return false;
}
function validRecurringProviderReference(row){
  const provider=recurringProvider(row);
  return Boolean(provider&&validRecurringProviderId(provider,row?.provider_subscription_id));
}

function currencyOf(row){
  return String(row?.currency_snapshot||row?.currency||'').trim().toUpperCase();
}

function sameCurrency(a,b){
  const left=currencyOf(a),right=currencyOf(b);
  return Boolean(left&&right&&left===right);
}

module.exports={BILLING_MODES,PROVIDER_RECURRING_SOURCES,normalize,modeFor,recurringProvider,isRecurring,validRecurringProviderId,validRecurringProviderReference,currencyOf,sameCurrency};
