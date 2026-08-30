'use strict';

require('dotenv').config();
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const refunds=require('../src/payments/refund-policy');
const expiry=require('../src/entitlements/subscription-expiry');

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
    if(/\.refunds\.create\s*\(/.test(text)||/\/v2\/payments\/captures\/[^'"`]+\/refund/.test(text))directRefundCalls.push(path.relative(path.join(__dirname,'..'),file).split(path.sep).join('/'));
  }
  assert.deepEqual(directRefundCalls,['src/payments/prorata-refunds.js'],'all direct provider-refund mutation must remain concentrated in the explicitly reviewed canonical pro-rata refund owner');

  const suffix=crypto.randomBytes(8).toString('hex');
  const ok=await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,amount_minor,currency,access_action,metadata)
    VALUES('stripe',$1,$2,'refund','recorded','unresolved',600,'GBP','preserve',$3::jsonb) RETURNING id`,[`evt_refund_cash_ok_${suffix}`,`ch_refund_cash_${suffix}`,JSON.stringify({providerPaidMinor:600,serviceCreditMinor:400,grossPurchaseMinor:1000})]);
  assert(ok.rowCount===1,'refund equal to actual provider cash must be accepted');
  await assert.rejects(()=>query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,amount_minor,currency,access_action,metadata)
    VALUES('stripe',$1,$2,'refund','recorded','unresolved',601,'GBP','preserve',$3::jsonb)`,[`evt_refund_cash_bad_${suffix}`,`ch_refund_cash_bad_${suffix}`,JSON.stringify({providerPaidMinor:600,serviceCreditMinor:400,grossPurchaseMinor:1000})]),/exceeds money paid through provider/i,'database must reject any attempt to make affiliate/service credit cash-refundable');

  const customer=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`Refund queue ${suffix}`,`refund-queue-${suffix}@example.invalid`])).rows[0];
  const plan=(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,$2,'jellyfin','direct','month',30,600,'GBP',100,TRUE,TRUE,1,'premium') RETURNING id`,[`refund-queue-plan-${suffix}`,`Refund queue plan ${suffix}`])).rows[0];
  const current=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,service_type_snapshot,billing_interval_snapshot,duration_days_snapshot) VALUES($1,$2,'active','stripe',$3,NOW()-INTERVAL '27 days',NOW()+INTERVAL '3 days','jellyfin','month',30) RETURNING *`,[customer.id,plan.id,`pi_current_${suffix}`])).rows[0];
  const queued1=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,service_type_snapshot,billing_interval_snapshot,duration_days_snapshot) VALUES($1,$2,'active','stripe',$3,NOW(),NOW()+INTERVAL '30 days','jellyfin','month',30) RETURNING *`,[customer.id,plan.id,`pi_refund_${suffix}`])).rows[0];
  const queued2=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,service_type_snapshot,billing_interval_snapshot,duration_days_snapshot) VALUES($1,$2,'active','stripe',$3,NOW(),NOW()+INTERVAL '30 days','jellyfin','month',30) RETURNING *`,[customer.id,plan.id,`pi_after_${suffix}`])).rows[0];
  assert(new Date(queued1.starts_at).getTime()>=new Date(current.current_period_end).getTime()-1000,'first top-up must already be queued after current access');
  assert(new Date(queued2.starts_at).getTime()>=new Date(queued1.current_period_end).getTime()-1000,'second top-up must already be queued after first top-up');

  const beforeWarnings=await expiry.expiringSubscriptions({days:7});
  assert(!beforeWarnings.some(row=>String(row.id)===String(current.id)),'current period must not warn when contiguous prepaid access is already queued');

  await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata)
    VALUES('stripe',$1,$2,'refund','recorded','direct',$3,$4,600,'GBP','preserve',$5::jsonb)`,[`evt_future_refund_${suffix}`,`re_future_refund_${suffix}`,customer.id,`pi_refund_${suffix}`,JSON.stringify({providerPaidMinor:600,originalAmountMinor:600,fullRefund:true})]);
  const refunded=(await query(`SELECT status FROM subscriptions WHERE id=$1`,[queued1.id])).rows[0];
  const shifted=(await query(`SELECT starts_at,current_period_end FROM subscriptions WHERE id=$1`,[queued2.id])).rows[0];
  assert.equal(refunded.status,'expired','a fully refunded future prepaid entitlement must never activate');
  assert(Math.abs(new Date(shifted.starts_at).getTime()-new Date(current.current_period_end).getTime())<5000,'later queued access must pull forward to close the refunded gap');

  const plainCustomer=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`Expiry warning ${suffix}`,`expiry-warning-${suffix}@example.invalid`])).rows[0];
  const plain=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,service_type_snapshot,billing_interval_snapshot,duration_days_snapshot) VALUES($1,$2,'active','stripe',$3,NOW()-INTERVAL '27 days',NOW()+INTERVAL '3 days','jellyfin','month',30) RETURNING *`,[plainCustomer.id,plan.id,`pi_plain_${suffix}`])).rows[0];
  const warnings=await expiry.expiringSubscriptions({days:7});
  assert(warnings.some(row=>String(row.id)===String(plain.id)),'a genuinely expiring prepaid account must still receive its expiry warning');

  console.log('refund cash-basis smoke: ok — provider-cash cap, canonical refund owner, future removal/queue compaction, and paid-through warning suppression');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
