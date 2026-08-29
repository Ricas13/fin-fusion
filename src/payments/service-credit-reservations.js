'use strict';

const {query,transaction}=require('../db');
const planPricing=require('./plan-pricing');
const accounting=require('./service-credit-accounting');

function cleanCurrency(value){return planPricing.cleanCurrency(value,'GBP');}
function int(value){const n=Number(value);return Number.isInteger(n)?n:0;}

async function availableMinorForClient(client,customerId,currency){
  return accounting.rawAvailableMinorForClient(client,customerId,cleanCurrency(currency));
}

async function availableMinor(customerId,currency){
  return transaction(client=>availableMinorForClient(client,customerId,currency));
}

async function reserveForIntent({customerId,checkoutIntentId,currency,maxAmountMinor,expiresAt}){
  const wanted=cleanCurrency(currency),maximum=Math.max(0,int(maxAmountMinor));
  if(!checkoutIntentId||maximum<=0)return{amountMinor:0,currency:wanted,reserved:false};
  return transaction(async client=>{
    await accounting.lockCustomer(client,customerId);
    await accounting.ensureHistoricalAllocations(client,customerId,wanted);
    const intent=(await client.query(`SELECT id,customer_id,state FROM billing_checkout_intents WHERE id=$1 FOR UPDATE`,[checkoutIntentId])).rows[0];
    if(!intent||String(intent.customer_id)!==String(customerId)||intent.state!=='open')throw new Error('Checkout intent is not available for service credit.');
    const existing=(await client.query(`SELECT * FROM affiliate_credit_checkout_reservations WHERE checkout_intent_id=$1`,[checkoutIntentId])).rows[0];
    if(existing)return{amountMinor:int(existing.amount_minor),currency:existing.currency,reserved:existing.state==='reserved'};
    const available=await availableMinorForClient(client,customerId,wanted),amount=Math.min(available,maximum);
    if(amount<=0)return{amountMinor:0,currency:wanted,reserved:false};
    const expiry=expiresAt instanceof Date?expiresAt:new Date(expiresAt||Date.now()+60*60*1000);
    const saved=(await client.query(`INSERT INTO affiliate_credit_checkout_reservations(customer_id,checkout_intent_id,currency,amount_minor,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *`,[customerId,checkoutIntentId,wanted,amount,expiry])).rows[0];
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('affiliate.credit.reserve','checkout_intent',$1,$2::jsonb)`,[String(checkoutIntentId),JSON.stringify({customerId,currency:wanted,amountMinor:amount,expiresAt:expiry.toISOString()})]);
    return{amountMinor:amount,currency:wanted,reserved:true,id:saved.id};
  });
}

async function settle(client,checkoutIntentId,state){
  if(!checkoutIntentId)return null;
  const row=(await client.query(`SELECT * FROM affiliate_credit_checkout_reservations WHERE checkout_intent_id=$1 FOR UPDATE`,[checkoutIntentId])).rows[0];
  if(!row||row.state!=='reserved')return row||null;
  await accounting.lockCustomer(client,row.customer_id);
  await accounting.ensureHistoricalAllocations(client,row.customer_id,row.currency);
  if(state==='expired')return row;
  if(state==='completed'){
    const inserted=await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note,metadata)
      VALUES($1,$2,$3,'redeemed','available',$4,$5,$6::jsonb)
      ON CONFLICT(entry_type,reference_id) DO NOTHING RETURNING *`,[row.customer_id,row.currency,-int(row.amount_minor),`mixed-checkout:${checkoutIntentId}`,'Applied service credit to provider checkout',JSON.stringify({checkoutIntentId:String(checkoutIntentId),reservationId:row.id})]);
    if(inserted.rowCount)await accounting.allocateOneDebit(client,inserted.rows[0]);
    await client.query(`UPDATE affiliate_credit_checkout_reservations SET state='applied',applied_at=NOW(),updated_at=NOW() WHERE id=$1`,[row.id]);
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('affiliate.credit.apply','checkout_intent',$1,$2::jsonb)`,[String(checkoutIntentId),JSON.stringify({customerId:row.customer_id,currency:row.currency,amountMinor:int(row.amount_minor)})]);
    return{...row,state:'applied'};
  }
  if(['cancelled','failed'].includes(state)){
    await client.query(`UPDATE affiliate_credit_checkout_reservations SET state='released',released_at=NOW(),updated_at=NOW() WHERE id=$1`,[row.id]);
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('affiliate.credit.release','checkout_intent',$1,$2::jsonb)`,[String(checkoutIntentId),JSON.stringify({customerId:row.customer_id,currency:row.currency,amountMinor:int(row.amount_minor),reason:state})]);
    return{...row,state:'released'};
  }
  return row;
}

async function reservationForIntent(checkoutIntentId){
  const r=await query(`SELECT * FROM affiliate_credit_checkout_reservations WHERE checkout_intent_id=$1`,[checkoutIntentId]);
  return r.rows[0]||null;
}

module.exports={availableMinorForClient,availableMinor,reserveForIntent,settle,reservationForIntent,cleanCurrency};
