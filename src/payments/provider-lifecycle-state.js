'use strict';

const PROVIDERS=Object.freeze({
  STRIPE:'stripe',
  PAYPAL:'paypal',
  PLISIO:'plisio'
});

const STRIPE_TERMINAL=Object.freeze(new Set(['canceled','cancelled','incomplete_expired']));
const PAYPAL_TERMINAL=Object.freeze(new Set(['CANCELLED','CANCELED','EXPIRED']));
const PLISIO_WAITING=Object.freeze(new Set(['new','pending','pending internal']));
const PLISIO_TERMINAL_UNPAID=Object.freeze(new Set(['expired','cancelled','cancelled duplicate','error','mismatch']));

function providerName(value){
  const provider=String(value||'').trim().toLowerCase();
  if(!Object.values(PROVIDERS).includes(provider))throw new Error(`Unsupported payment provider: ${provider||'(empty)'}`);
  return provider;
}

function normalizeStatus(provider,value){
  const name=providerName(provider);
  const raw=String(value||'').trim();
  return name===PROVIDERS.PAYPAL?raw.toUpperCase():raw.toLowerCase();
}

function isTerminal(provider,status){
  const name=providerName(provider);
  const normalized=normalizeStatus(name,status);
  if(name===PROVIDERS.STRIPE)return STRIPE_TERMINAL.has(normalized);
  if(name===PROVIDERS.PAYPAL)return PAYPAL_TERMINAL.has(normalized);
  return PLISIO_TERMINAL_UNPAID.has(normalized);
}

function isWaiting(provider,status){
  const name=providerName(provider);
  const normalized=normalizeStatus(name,status);
  if(name===PROVIDERS.PLISIO)return PLISIO_WAITING.has(normalized);
  if(name===PROVIDERS.PAYPAL)return ['APPROVAL_PENDING','APPROVED'].includes(normalized);
  return ['incomplete','processing'].includes(normalized);
}

function isHealthy(provider,status){
  const name=providerName(provider);
  const normalized=normalizeStatus(name,status);
  if(name===PROVIDERS.PAYPAL)return normalized==='ACTIVE';
  if(name===PROVIDERS.PLISIO)return normalized==='completed';
  return ['active','trialing'].includes(normalized);
}

module.exports={
  PROVIDERS,
  STRIPE_TERMINAL,
  PAYPAL_TERMINAL,
  PLISIO_WAITING,
  PLISIO_TERMINAL_UNPAID,
  providerName,
  normalizeStatus,
  isTerminal,
  isWaiting,
  isHealthy
};
