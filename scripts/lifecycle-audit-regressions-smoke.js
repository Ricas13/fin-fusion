'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const paypal=require('../src/payments/paypal');

const root=path.resolve(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');

function paypalPaidThroughCancellation(){
  const future=new Date(Date.now()+10*24*60*60*1000);
  const past=new Date(Date.now()-10*24*60*60*1000);
  const cancelled={status:'CANCELLED',billing_info:{next_billing_time:null}};
  const active={status:'ACTIVE',billing_info:{next_billing_time:future.toISOString()}};

  const preserved=paypal.paidThroughCancellationUpdate({status:'active',billing_mode:'subscription',current_period_end:future,refund_terminated_at:null},cancelled);
  assert.equal(preserved.preserved,true,'PayPal cancellation must preserve already-paid future access');
  assert.equal(preserved.providerStatus,'ACTIVE','preserved PayPal cancellation must remain locally active');
  assert.equal(preserved.cancelAtPeriodEnd,true,'preserved PayPal cancellation must stop renewal');
  assert.equal(new Date(preserved.periodEnd).getTime(),future.getTime(),'paid-through boundary must not be shortened');

  const expired=paypal.paidThroughCancellationUpdate({status:'active',billing_mode:'subscription',current_period_end:past,refund_terminated_at:null},cancelled);
  assert.equal(expired.preserved,false,'PayPal cancellation after the paid-through date must be terminal');
  assert.equal(expired.providerStatus,'CANCELLED');

  const refunded=paypal.paidThroughCancellationUpdate({status:'active',billing_mode:'subscription',current_period_end:future,refund_terminated_at:new Date()},cancelled);
  assert.equal(refunded.preserved,false,'refund termination must override paid-through cancellation preservation');

  const stillActive=paypal.paidThroughCancellationUpdate({status:'active',billing_mode:'subscription',current_period_end:future,refund_terminated_at:null},active);
  assert.equal(stillActive.preserved,false,'normal ACTIVE state must pass through without cancellation rewriting');
  assert.equal(stillActive.providerStatus,'ACTIVE');
}

function jellyfinDeletionScope(){
  const text=source('src/platform/operator-bulk-operations.js');
  assert.match(text,/jellyfinAdminControl\.remove\(item\.customer_id,null,/,'Jellyfin delete must persist service-scoped removal authority');
  assert.match(text,/deleteJellyfinAccounts\(item\.customer_id,\{[^}]*holdAccess:false/,'Jellyfin delete must not create a customer-wide access hold');
}

function deferredWebhookContract(){
  const text=source('src/platform/webhooks.js');
  assert.match(text,/result\?\.processingError/,'payment webhooks must inspect durable business-processing failure');
  assert.match(text,/status\(503\)/,'deferred payment webhook must return a retriable HTTP status');
  assert.match(text,/stripe\.processWebhook[\s\S]*deferredPaymentWebhook/,'Stripe must use deferred acknowledgement handling');
  assert.match(text,/paypal\.processWebhook[\s\S]*deferredPaymentWebhook/,'PayPal must use deferred acknowledgement handling');
}

function discoveryAutomationContract(){
  const jobs=source('src/automation/jobs.js');
  const critical=source('src/automation/critical-jobs.js');
  const worker=source('scripts/automation-worker.js');
  assert.match(jobs,/subscriptionDiscovery\.apply\(null\)/,'safe provider subscription discovery must be runnable automatically');
  assert.match(critical,/'subscription_discovery'/,'provider discovery must be lifecycle-critical');
  assert.match(worker,/subscription_discovery:21600/,'provider discovery must have a bounded recurring cadence');
}

function independentServiceRecoveryContract(){
  const text=source('src/automation/customer-service-recovery.js');
  for(const marker of ['recoverStremio','recoverEmby','recoverDiscord'])assert.match(text,new RegExp(`async function ${marker}\\b`),`${marker} must remain independently recoverable`);
  assert.match(text,/customer_service_recovery|recoverCustomer/,'customer service recovery must remain independently executable');
}

paypalPaidThroughCancellation();
jellyfinDeletionScope();
deferredWebhookContract();
discoveryAutomationContract();
independentServiceRecoveryContract();
console.log('Lifecycle audit regression smoke passed.');
