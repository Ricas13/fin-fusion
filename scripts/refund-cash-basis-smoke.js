'use strict';

require('dotenv').config();
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const refunds=require('../src/payments/refund-policy');

function source(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}
function productionJs(dir){const out=[];for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())out.push(...productionJs(full));else if(entry.isFile()&&entry.name.endsWith('.js'))out.push(full);}return out;}

async function main(){
  const mixed={grossDiscountedMinor:1000,serviceCreditMinor:400,discountedMinor:600};
  assert.equal(refunds.providerCashPaidMinor(mixed),600,'£10 purchase with £4 service credit must have a £6 cash refund basis');
  assert.deepEqual(refunds.assertProviderRefund({providerPaidMinor:600,requestedMinor:600}),{requestedMinor:600,remainingBeforeMinor:600,remainingAfterMinor:0});
  assert.throws(()=>refunds.assertProviderRefund({providerPaidMinor:600,requestedMinor:601}),error=>error?.code==='REFUND_EXCEEDS_PROVIDER_CASH_PAID','cash refund must never include the service-credit portion');
  assert.equal(refunds.remainingProviderRefundableMinor({providerPaidMinor:600,refundedMinor:250}),350,'partial cash refunds must reduce only the remaining provider cash');
  assert.throws(()=>refunds.assertProviderRefund({providerPaidMinor:600,refundedMinor:250,requestedMinor:351}),error=>error?.code==='REFUND_EXCEEDS_PROVIDER_CASH_PAID','cumulative refunds must never exceed provider cash paid');
  assert.equal(refunds.providerCashPaidMinor({providerPaidMinor:0,serviceCreditMinor:1000,grossDiscountedMinor:1000}),0,'fully service-credit-funded purchases have no cash refund basis');

  const flexible=source('src/platform/flexible-checkout.js'),stripe=source('src/payments/stripe.js'),paypal=source('src/payments/paypal.js');
  assert(flexible.includes('grossDiscountedMinor:grossDue,serviceCreditMinor,serviceCreditCurrency:serviceCreditMinor?choice.currency:null,discountedMinor:providerDue'),'mixed checkout snapshot must preserve gross/service-credit split while provider due remains the verified cash amount');
  assert(stripe.includes('amount=Number(charge?.amount||0),refunded=Number(charge?.amount_refunded||0)'),'Stripe refund accounting must use the actual charge, not the gross plan price');
  assert(stripe.includes('originalAmountMinor:amount'),'Stripe refund incidents must persist the actual provider charge as refund evidence');
  assert(paypal.includes('finalAmountMinor'),'PayPal one-time checkout must receive the reduced provider amount for mixed service-credit purchases');

  const directRefundCalls=[];
  for(const file of productionJs(path.join(__dirname,'..','src'))){
    const text=fs.readFileSync(file,'utf8');
    if(/\.refunds\.create\s*\(/.test(text)||/\/v2\/payments\/captures\/[^'"`]+\/refund/.test(text))directRefundCalls.push(path.relative(path.join(__dirname,'..'),file));
  }
  assert.deepEqual(directRefundCalls,[],'CAPTAiNFiN must not gain a direct provider-refund mutation outside an explicitly reviewed canonical refund owner');

  const suffix=crypto.randomBytes(8).toString('hex');
  const ok=await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,amount_minor,currency,access_action,metadata)
    VALUES('stripe',$1,$2,'refund','recorded','unresolved',600,'GBP','preserve',$3::jsonb) RETURNING id`,[`evt_refund_cash_ok_${suffix}`,`ch_refund_cash_${suffix}`,JSON.stringify({providerPaidMinor:600,serviceCreditMinor:400,grossPurchaseMinor:1000})]);
  assert(ok.rowCount===1,'refund equal to actual provider cash must be accepted');
  await assert.rejects(()=>query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,amount_minor,currency,access_action,metadata)
    VALUES('stripe',$1,$2,'refund','recorded','unresolved',601,'GBP','preserve',$3::jsonb)`,[`evt_refund_cash_bad_${suffix}`,`ch_refund_cash_bad_${suffix}`,JSON.stringify({providerPaidMinor:600,serviceCreditMinor:400,grossPurchaseMinor:1000})]),/exceeds money paid through provider/i,'database must reject any attempt to make affiliate/service credit cash-refundable');

  console.log('refund cash-basis smoke: ok — cash refunds are capped to provider-paid value; service credit is never cash-refundable');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
