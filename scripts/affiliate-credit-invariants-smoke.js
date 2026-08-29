'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const {query,transaction,getPool}=require('../src/db');
const referrals=require('../src/referrals');
const credits=require('../src/affiliate-credits');
const accounting=require('../src/payments/service-credit-accounting');
const incidents=require('../src/payments/incidents');

const suffix=crypto.randomBytes(5).toString('hex');
const id=label=>`${label}-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
async function setRate(rate){await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[JSON.stringify({enabled:true,rewardPercent:rate,qualificationDelayDays:0,refundWindowDays:0})]);}
async function customer(label){return(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[label,`${id(label)}@example.invalid`])).rows[0];}
async function plan(label,price=10000){return(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,$2,'jellyfin','direct','month',30,$3,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`,[id(label),label,price])).rows[0];}
async function newAffiliate(label){const c=await customer(label);await credits.enroll(c.id);return c;}
async function rewardPurchase(affiliate,label,{gross=10000,provider='stripe'}={}){
  const referred=await customer(`${label}-buyer`),p=await plan(`${label}-plan`,gross),code=(await query(`SELECT code FROM referral_codes WHERE customer_id=$1`,[affiliate.id])).rows[0].code;
  await referrals.attributeReferral(referred.id,code);
  const providerId=`${provider}-${id(label)}`;
  const sub=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,price_minor_snapshot,currency_snapshot,commercial_snapshot) VALUES($1,$2,'active',$3,NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days',$4,$5,'GBP',$6::jsonb) RETURNING *`,[referred.id,p.id,provider,providerId,gross,JSON.stringify({discountedMinor:gross})])).rows[0];
  const result=await referrals.rewardIfQualifying(referred.id);assert.equal(result?.rewarded,true,`${label} did not reward`);
  const redemption=(await query(`SELECT * FROM referral_redemptions WHERE referred_customer_id=$1`,[referred.id])).rows[0];
  const grant=(await query(`SELECT * FROM affiliate_credit_ledger WHERE referral_redemption_id=$1 AND entry_type='earned'`,[redemption.id])).rows[0];
  return{affiliate,referred,sub,redemption,grant,gross};
}
async function refund(purchase,eventId,amount){
  const recorded=await incidents.record({provider:'stripe',eventId,caseId:`case-${eventId}`,kind:'refund',status:'recorded',identity:{scope:'direct',customerId:purchase.referred.id},providerSubscriptionId:purchase.sub.provider_subscription_id,amountMinor:amount,currency:'GBP',metadata:{originalAmountMinor:purchase.gross,fullRefund:amount>=purchase.gross}});
  return referrals.revisitRewardAfterAdversePayment({referredCustomerId:purchase.referred.id,incidentId:recorded.incident?.id||null,reason:`stripe:refund:${eventId}`});
}
async function chargeback(purchase,eventId){
  const incident=(await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata) VALUES('stripe',$1,$2,'chargeback','lost','direct',$3,$4,$5,'GBP','preserve','{}'::jsonb) RETURNING *`,[eventId,`case-${eventId}`,purchase.referred.id,purchase.sub.provider_subscription_id,purchase.gross])).rows[0];
  return{incident,result:await referrals.revisitRewardAfterAdversePayment({referredCustomerId:purchase.referred.id,incidentId:incident.id,reason:`stripe:chargeback:${eventId}`})};
}
async function spend(customerId,amount,reference=id('spend')){
  return transaction(async client=>{
    await accounting.lockCustomer(client,customerId);await accounting.ensureHistoricalAllocations(client,customerId,'GBP');
    const available=await accounting.rawAvailableMinorForClient(client,customerId,'GBP');if(available<amount)throw new Error('insufficient service credit');
    const row=(await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note,metadata) VALUES($1,'GBP',$2,'redeemed','available',$3,'invariant smoke spend','{}'::jsonb) RETURNING *`,[customerId,-amount,reference])).rows[0];
    await accounting.allocateOneDebit(client,row);return row;
  });
}
async function balance(customerId){return (await credits.balances(customerId)).find(x=>x.currency==='GBP')||{available_minor:0,recoverable_minor:0};}

async function main(){
  await setRate(25);

  // A: reverse A, then earn B. B remains fully available.
  const aAffiliate=await newAffiliate('A-affiliate'),a=await rewardPurchase(aAffiliate,'A1');
  await refund(a,`evt-A-full-${suffix}`,10000);const b=await rewardPurchase(aAffiliate,'A2');
  assert.equal((await balance(aAffiliate.id)).available_minor,2500,'A: later reward B was swallowed by A reversal');
  assert(b.grant.id);

  // B: spend is FIFO-allocated to A; reversing A cannot consume B.
  const bAffiliate=await newAffiliate('B-affiliate'),ba=await rewardPurchase(bAffiliate,'B-A'),bb=await rewardPurchase(bAffiliate,'B-B');
  const spendB=await spend(bAffiliate.id,1000);const allocatedA=(await query(`SELECT COALESCE(SUM(amount_minor),0)::int n FROM affiliate_credit_allocations WHERE debit_ledger_id=$1 AND grant_ledger_id=$2`,[spendB.id,ba.grant.id])).rows[0].n;
  assert.equal(Number(allocatedA),1000,'B: FIFO spend was not allocated to reward A');
  await refund(ba,`evt-B-full-${suffix}`,10000);const bBal=await balance(bAffiliate.id);
  assert.equal(bBal.available_minor,2500,'B: reversing A consumed reward B');assert.equal(bBal.recoverable_minor,1000,'B: already-spent A value was not tracked explicitly');assert(bb.grant.id);

  // C/D: £100 at 25%, £5 refund => £23.75; cumulative partials and replay are idempotent.
  const cAffiliate=await newAffiliate('C-affiliate'),c=await rewardPurchase(cAffiliate,'C');
  await refund(c,`evt-C-5-${suffix}`,500);assert.equal((await balance(cAffiliate.id)).available_minor,2375,'C: £5 refund did not reconcile reward to £23.75');
  await refund(c,`evt-C-10-${suffix}`,1000);assert.equal((await balance(cAffiliate.id)).available_minor,2250,'D: second cumulative partial refund was double-counted');
  await refund(c,`evt-C-10-${suffix}`,1000);assert.equal((await balance(cAffiliate.id)).available_minor,2250,'D/H: provider event replay changed credit twice');

  // E: full refund after partials converges to zero.
  await refund(c,`evt-C-full-${suffix}`,10000);assert.equal((await balance(cAffiliate.id)).available_minor,0,'E: full refund after partial refund did not converge to zero');

  // F: chargeback after spend preserves delivered service and records explicit recovery.
  const fAffiliate=await newAffiliate('F-affiliate'),f=await rewardPurchase(fAffiliate,'F');await spend(fAffiliate.id,2500);const fChargeback=await chargeback(f,`evt-F-cb-${suffix}`);
  let fBal=await balance(fAffiliate.id);assert.equal(fBal.available_minor,0,'F: chargeback created spendable negative/positive drift');assert.equal(fBal.recoverable_minor,2500,'F: spent reversed affiliate value was not explicit recovery');
  await referrals.revisitRewardAfterAdversePayment({referredCustomerId:f.referred.id,incidentId:fChargeback.incident.id,reason:`stripe:chargeback:evt-F-cb-${suffix}`});
  fBal=await balance(fAffiliate.id);assert.equal(fBal.recoverable_minor,2500,'F/H: chargeback replay double-counted recoverable value');

  // G: unrelated admin top-up survives affiliate reversal.
  const gAffiliate=await newAffiliate('G-affiliate'),g=await rewardPurchase(gAffiliate,'G');await credits.adminAdjustCredit({customerId:gAffiliate.id,currency:'GBP',amountMinor:400,reason:'Invariant smoke admin top-up'});await refund(g,`evt-G-full-${suffix}`,10000);
  assert.equal((await balance(gAffiliate.id)).available_minor,400,'G: affiliate reversal consumed unrelated admin top-up');

  // Rate correction after a partial refund uses the surviving net paid basis.
  const tAffiliate=await newAffiliate('T-affiliate'),t=await rewardPurchase(tAffiliate,'T');await refund(t,`evt-T-5-${suffix}`,500);await setRate(30);
  const topUp=await credits.topUpRewardToCurrentRate({creditId:t.grant.id,reason:'Net-basis top-up invariant smoke'});
  assert.equal(topUp.topUpMinor,475,'Partial-refund rate top-up did not use the £95 net paid basis');assert.equal((await balance(tAffiliate.id)).available_minor,2850,'Rate top-up recreated or omitted refunded affiliate value');
  await setRate(25);

  // I: concurrent spend/reversal serializes on the customer row. Either reversal wins
  // (spend is rejected) or spend wins (delivered value becomes explicit recovery).
  const iAffiliate=await newAffiliate('I-affiliate'),i=await rewardPurchase(iAffiliate,'I');
  const race=await Promise.allSettled([spend(iAffiliate.id,2000,id('I-spend')),refund(i,`evt-I-full-${suffix}`,10000)]);const iBal=await balance(iAffiliate.id);
  assert(iBal.available_minor>=0,'I: race produced a negative spendable balance');
  const spendSucceeded=race[0].status==='fulfilled';
  if(spendSucceeded)assert.equal(iBal.recoverable_minor,2000,'I: winning concurrent spend was not captured as recovery');else assert.match(String(race[0].reason?.message||''),/insufficient service credit/,'I: concurrent spend failed for an unexpected reason');
  const allocationOverrun=await query(`SELECT g.id,g.amount_minor,COALESCE(SUM(a.amount_minor),0)::int allocated FROM affiliate_credit_ledger g LEFT JOIN affiliate_credit_allocations a ON a.grant_ledger_id=g.id WHERE g.customer_id=$1 AND g.amount_minor>0 GROUP BY g.id HAVING COALESCE(SUM(a.amount_minor),0)>g.amount_minor`,[iAffiliate.id]);assert.equal(allocationOverrun.rowCount,0,'I: concurrent operations over-allocated a grant source');

  console.log('affiliate credit invariants smoke: A-I plus replay/net-top-up passed');
}
main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
