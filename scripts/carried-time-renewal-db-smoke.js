'use strict';

// PostgreSQL checks for "a payment always adds time": a new auto-renewing
// agreement carries the paid time of identical access, renewals keep it, and
// refunds take back exactly what was refunded.
require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('carried-time renewal DB smoke')) process.exit(0);

const assert=require('assert');
const {query,transaction,getPool}=require('../src/db');
const extensions=require('../src/payments/subscription-access-extensions');
const lifecycle=require('../src/payments/lifecycle-primitives');
const incidents=require('../src/payments/incidents');
const prepaidRefunds=require('../src/payments/lifecycle-prepaid-refunds');
const termination=require('../src/payments/subscription-termination');
const carriedTime=require('../src/payments/carried-time');
const operatorRefund=require('../src/payments/operator-refund');
const crypto=require('crypto');

const DAY=86400000;
const suffix=Date.now().toString(36);
const customerIds=[],planIds=[];
let sequence=0;
const ms=value=>new Date(value).getTime();
const fromNow=days=>new Date(Date.now()+days*DAY);
const same=(actual,expected,message)=>assert(Math.abs(ms(actual)-ms(expected))<2,`${message} (got ${new Date(actual).toISOString()}, expected ${new Date(expected).toISOString()})`);

async function makeCustomer(label){
  const name=`carried-${label}-${suffix}-${++sequence}`;
  const row=(await query('INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *',[name,`${name}@example.invalid`])).rows[0];
  customerIds.push(row.id);return row;
}
async function makePlan(label,{interval='month',days=30,streams=1,serverClass='premium',service='emby'}={}){
  const code=`carried-${label}-${suffix}-${++sequence}`;
  const row=(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,$2,'direct',$3,$4,600,'GBP',500,TRUE,TRUE,$5,$6) RETURNING *`,[code,service,interval,days,streams,serverClass])).rows[0];
  planIds.push(row.id);return row;
}
async function get(id){
  return(await query(`SELECT *,current_period_end+((COALESCE(service_extension_days,0)||' days')::interval) AS access_end FROM subscriptions WHERE id=$1`,[id])).rows[0];
}
// A held row, written as the database would receive it.
async function insert(customer,plan,{source='migration',ref,status='active',start=-5,end=30,ext=0,cancelAtEnd=false,recurring=false}={}){
  const provider=['stripe','paypal','plisio'].includes(source);
  const reference=ref!==undefined?ref:provider?`${recurring?'sub_':'pi_'}carried_${suffix}_${++sequence}`:null;
  const snapshot=provider?{kind:'direct_plan',checkoutMode:recurring?'subscription':'payment',billingInterval:'month',durationDays:30}:{};
  const row=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,
      service_extension_days,cancel_at_period_end,billing_interval_snapshot,duration_days_snapshot,commercial_snapshot,billing_mode)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING id`,
  [customer.id,plan.id,status,source,reference,start instanceof Date?start:fromNow(start),end instanceof Date?end:fromNow(end),ext,cancelAtEnd,
    plan.billing_interval,plan.duration_days,JSON.stringify(snapshot),recurring?'subscription':provider?'payment':'manual'])).rows[0];
  return get(row.id);
}
function contract(plan,provider,extra={}){
  return{kind:'direct_plan',provider,planId:plan.id,planCode:plan.code,planName:plan.name,priceMinor:600,discountedMinor:600,currency:'GBP',
    billingInterval:plan.billing_interval,durationDays:plan.duration_days,checkoutMode:'subscription',streams:plan.streams,serverClass:plan.server_class,
    accessVariantKind:'streams',accessQuantity:plan.streams,...extra};
}
// Buys a new auto-renewing agreement the way a verified checkout does.
async function renewing(customer,plan,{ref=`sub_carried_${suffix}_${++sequence}`,provider='stripe',providerStatus='active',periodEnd=fromNow(365),extra={}}={}){
  const row=await lifecycle.activatePurchase({customerId:customer.id,planId:plan.id,provider,providerSubscriptionId:ref,providerStatus,
    periodStart:new Date(),periodEnd,commercialSnapshot:contract(plan,provider,extra)});
  return{row:await get(row.id),ref,periodEnd};
}
const ledger=async target=>(await query('SELECT * FROM subscription_time_carryovers WHERE target_subscription_id=$1 ORDER BY created_at,source_subscription_id',[target])).rows;
async function extend(customer,plan,subscription,ref=`pi_carried_extend_${suffix}_${++sequence}`){
  const commercialSnapshot=contract(plan,'stripe',{kind:'subscription_extension',checkoutMode:'payment',extensionSubscriptionId:subscription.id,billingInterval:'month',durationDays:30});
  const applied=await transaction(client=>extensions.applyPurchase(client,{customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'stripe',providerPaymentId:ref,commercialSnapshot}));
  return{ref,days:Number(applied.extension.purchased_days)};
}
const refund=(customer,row,eventId=`evt_carried_${suffix}_${++sequence}`)=>incidents.record({
  provider:row.source,eventId,caseId:eventId,kind:'refund',status:'recorded',identity:{scope:'direct',customerId:customer.id},
  providerSubscriptionId:row.provider_subscription_id,amountMinor:600,currency:'GBP',metadata:{fullRefund:true,originalAmountMinor:600}});
const chargeback=(customer,row,eventId=`evt_carried_cb_${suffix}_${++sequence}`)=>incidents.record({
  provider:row.source,eventId,caseId:eventId,kind:'chargeback',status:'lost',identity:{scope:'direct',customerId:customer.id},
  providerSubscriptionId:row.provider_subscription_id,amountMinor:600,currency:'GBP',metadata:{}});
const blocked=async row=>(await query('SELECT public.subscription_access_blocked($1,$2,$3) AS blocked',[row.customer_id,row.source,row.provider_subscription_id])).rows[0].blocked;
const operatorItems=async(customer,reason)=>(await query(`SELECT * FROM payment_incidents WHERE customer_id=$1 AND incident_type='checkout_completion' AND metadata->>'reason'=$2`,[customer.id,reason])).rows;

let half,year;

async function carryAndRenewals(){
  const customer=await makeCustomer('imported');
  const imported=await insert(customer,half,{end:233.5});
  const bought=await renewing(customer,year);
  assert.equal(bought.row.service_extension_days,234,'234 remaining days are added');
  same(bought.row.access_end,ms(bought.periodEnd)+234*DAY,'end = the new period plus the remaining days');
  const source=await get(imported.id);
  assert.equal(String(source.superseded_by),String(bought.row.id));
  assert.equal(source.replacement_reason,'paid_time_carried');
  same(source.current_period_end,imported.current_period_end,'the source window is not changed');
  let entries=await ledger(bought.row.id);
  assert.equal(entries.length,1);assert.equal(entries[0].status,'active');assert.equal(entries[0].applied_days,234);

  const replay=await renewing(customer,year,{ref:bought.ref,periodEnd:bought.periodEnd});
  assert.equal(replay.row.id,bought.row.id);
  assert.equal(replay.row.service_extension_days,234,'a replay carries once');
  assert.equal((await ledger(bought.row.id)).length,1);

  for(const days of [730,1095]){
    const periodEnd=fromNow(days);
    await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:bought.ref,providerStatus:'active',periodEnd});
    same((await get(bought.row.id)).access_end,ms(periodEnd)+234*DAY,'a renewal keeps the carried days');
  }

  const bonus=await extend(customer,year,bought.row);
  assert.equal((await get(bought.row.id)).service_extension_days,234+bonus.days,'Extend adds on top of carried days');
  await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:bought.ref,providerStatus:'active',periodEnd:fromNow(1460)});
  const afterRenewal=(await get(bought.row.id)).service_extension_days;
  assert(afterRenewal>=234+28&&afterRenewal<=234+31,'both survive the next renewal');
  await extensions.revokeByProviderPayment({provider:'stripe',providerPaymentId:bonus.ref,customerId:customer.id});
  assert.equal((await get(bought.row.id)).service_extension_days,234,'reversing the extension leaves the carried days');
}

async function sourceRefunds(){
  const customer=await makeCustomer('source-refund');
  const first=await insert(customer,half,{source:'stripe',start:-5,end:19.5});
  const queued=await insert(customer,half,{source:'stripe'});
  const queuedSpan=Math.ceil((ms(queued.current_period_end)-ms(queued.starts_at))/DAY);
  const bought=await renewing(customer,year);
  assert.equal(bought.row.service_extension_days,20+queuedSpan,'a queued purchase is carried with its full span');
  // An ending agreement holds later purchases behind its whole access slot.
  await query('UPDATE subscriptions SET cancel_at_period_end=TRUE WHERE id=$1',[bought.row.id]);
  const waiting=await insert(customer,year,{source:'stripe'});
  same(waiting.starts_at,(await get(bought.row.id)).access_end,'fixture: queued behind the carried time');

  const eventId=`evt_carried_source_${suffix}`;
  await refund(customer,first,eventId);
  assert.equal((await get(bought.row.id)).service_extension_days,queuedSpan,'the refunded source days are taken back');
  assert((await get(first.id)).refund_terminated_at,'the source is marked refunded');
  same((await get(waiting.id)).starts_at,(await get(bought.row.id)).access_end,'the queue moves earlier');
  await refund(customer,first,eventId);
  await refund(customer,first);
  assert.equal((await get(bought.row.id)).service_extension_days,queuedSpan,'a duplicate or second incident removes nothing more');

  await chargeback(customer,queued);
  assert.equal((await get(bought.row.id)).service_extension_days,0,'a lost chargeback takes its days back');
  assert.deepStrictEqual((await ledger(bought.row.id)).map(row=>row.status),['reversed','reversed']);
}

// A web process that predates carried time only inserts the incident.
async function databaseOnlyReversal(){
  const customer=await makeCustomer('trigger');
  const paid=await insert(customer,half,{source:'plisio',end:39.5});
  const bought=await renewing(customer,year);
  await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata)
    VALUES('plisio',$1,$1,'chargeback','lost','unresolved',NULL,$2,600,'GBP','preserve','{}'::jsonb)`,[`evt_carried_db_${suffix}`,paid.provider_subscription_id]);
  assert.equal((await get(bought.row.id)).service_extension_days,0,'the database alone reverses carried time');
}

async function proRata(){
  const customer=await makeCustomer('prorata');
  const current=await insert(customer,half,{source:'stripe',start:-10,end:19.5});
  const queued=await insert(customer,half,{source:'stripe'});
  const bought=await renewing(customer,year);
  const total=bought.row.service_extension_days;
  const queuedSpan=Math.ceil((ms(queued.current_period_end)-ms(queued.starts_at))/DAY);
  const run=()=>prepaidRefunds.applyPrepaidRefund({subscriptionId:queued.id,customerId:customer.id,originalEnd:queued.current_period_end,cutoffAt:queued.starts_at,serviceType:'emby'});
  await run();
  assert.equal((await get(bought.row.id)).service_extension_days,total-queuedSpan,'exactly the refunded span is removed');
  await run();
  assert.equal((await get(bought.row.id)).service_extension_days,total-queuedSpan,'a retry removes nothing more');
  const row=await get(current.id);
  await prepaidRefunds.applyPrepaidRefund({subscriptionId:current.id,customerId:customer.id,originalEnd:row.current_period_end,cutoffAt:new Date(),serviceType:'emby'});
  assert((await get(bought.row.id)).service_extension_days<=1,'a started source loses its unused time');
}

async function sourceExtensions(){
  const customer=await makeCustomer('source-extension');
  const paid=await insert(customer,half,{source:'stripe',end:19.5});
  const first=await extend(customer,half,paid),second=await extend(customer,half,await get(paid.id));
  const held=(await get(paid.id)).service_extension_days;
  const bought=await renewing(customer,year);
  assert.equal(bought.row.service_extension_days,20+held,'Extend days on the source are carried');
  await extensions.revokeByProviderPayment({provider:'stripe',providerPaymentId:second.ref,customerId:customer.id});
  const afterExtension=(await get(bought.row.id)).service_extension_days;
  assert(afterExtension<20+held&&afterExtension>=20+first.days-1,'a reversed source extension comes off the new plan');
  await refund(customer,paid);
  const kept=(await get(bought.row.id)).service_extension_days;
  assert(kept>=first.days-1&&kept<=first.days+1,`refunding the base payment keeps the separately bought days (kept ${kept})`);
}

async function firstTermAndLater(){
  const customer=await makeCustomer('first-term');
  const imported=await insert(customer,half,{end:99.5});
  const bought=await renewing(customer,year);
  await chargeback(customer,bought.row);
  const source=await get(imported.id);
  assert.equal(source.superseded_by,null,'the source comes back');
  same(source.current_period_end,imported.current_period_end,'with its original end');
  assert.equal((await get(bought.row.id)).service_extension_days,0);
  assert.deepStrictEqual((await ledger(bought.row.id)).map(row=>row.status),['returned']);
  await termination.terminateForRefund(bought.row.id,customer.id,{reason:'repeat'});
  assert.deepStrictEqual((await ledger(bought.row.id)).map(row=>row.status),['returned'],'returned once');

  const later=await makeCustomer('later-term');
  const older=await insert(later,half,{end:49.5});
  const agreement=await renewing(later,year);
  await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:agreement.ref,providerStatus:'active',periodEnd:fromNow(730)});
  await termination.terminateForRefund(agreement.row.id,later.id,{reason:'renewal refunded'});
  assert.equal(String((await get(older.id)).superseded_by),String(agreement.row.id),'nothing is granted automatically');
  assert.equal((await operatorItems(later,'carried_time_owed_after_renewal_loss')).length,1,'an operator is told the days are owed');

  // The replayed checkout of a refunded payment hands the sources back too.
  const replayed=await makeCustomer('replayed-loss');
  const kept=await insert(replayed,half,{end:29.5});
  const row=await renewing(replayed,year);
  await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,access_action,metadata)
    VALUES('stripe',$1,$1,'refund','recorded','direct',$2,$3,'preserve','{"fullRefund":true,"currentTermLoss":true}'::jsonb)`,[`evt_carried_replay_${suffix}`,replayed.id,row.ref]);
  await renewing(replayed,year,{ref:row.ref,periodEnd:row.periodEnd});
  assert.equal((await get(kept.id)).superseded_by,null);
}

async function pastDue(){
  for(const [label,advance] of [['advanced',730],['not-advanced',0]]){
    const customer=await makeCustomer('past-due-'+label);
    await insert(customer,half,{end:99.5});
    const bought=await renewing(customer,year,{periodEnd:fromNow(0.001)});
    await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:bought.ref,providerStatus:'past_due',periodEnd:advance?fromNow(advance):null});
    assert.equal(await blocked(await get(bought.row.id)),false,label+': carried days stay usable while a renewal is unpaid');
    await query(`UPDATE customer_access_holds SET created_at=NOW()-INTERVAL '101 days' WHERE customer_id=$1`,[customer.id]);
    if(!advance)await query(`UPDATE subscriptions SET current_period_end=NOW()-INTERVAL '101 days' WHERE id=$1`,[bought.row.id]);
    assert.equal(await blocked(await get(bought.row.id)),true,label+': blocked once the paid-through date has passed');
  }
  const none=await makeCustomer('past-due-none');
  const plain=await renewing(none,year);
  await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:plain.ref,providerStatus:'past_due'});
  assert.equal(await blocked(await get(plain.row.id)),true,'a row without extra days is blocked as before');

  const ended=await makeCustomer('past-due-ended');
  await insert(ended,half,{end:99.5});
  const bought=await renewing(ended,year);
  await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:bought.ref,providerStatus:'past_due',periodEnd:fromNow(730)});
  for(let delivery=0;delivery<2;delivery++){
    await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:bought.ref,providerStatus:'canceled',periodEnd:fromNow(730)});
    const row=await get(bought.row.id);
    assert(Math.abs(ms(row.access_end)-(Date.now()+100*DAY))<DAY,'the unpaid period is not added before the carried days');
  }
}

async function purchasedExtensionsAfterUnpaidRenewal(){
  for(const provider of ['stripe','paypal']){
    const customer=await makeCustomer('bought-extension-unpaid-'+provider);
    const bought=await renewing(customer,year,{provider,periodEnd:fromNow(365)});
    const original=(await get(bought.row.id)).current_period_end;
    await extend(customer,year,bought.row);
    const before=await get(bought.row.id);
    assert(Number(before.service_extension_days)>0,'fixture has independently purchased extension time');
    assert.strictEqual((await ledger(bought.row.id)).length,0,'fixture has no carried-over time');
    const ref=bought.ref;
    // The provider has advanced the date for a renewal that did not settle.
    // A terminal event must not grant that unpaid year before the extension.
    await lifecycle.updateProviderSubscription({provider,providerSubscriptionId:ref,providerStatus:'past_due',periodEnd:fromNow(730)});
    for(let delivery=0;delivery<2;delivery++){
      await lifecycle.updateProviderSubscription({provider,providerSubscriptionId:ref,providerStatus:'cancelled',periodEnd:fromNow(730)});
      const row=await get(bought.row.id);
      assert(Math.abs(ms(row.access_end)-(Date.now()+Number(row.service_extension_days)*DAY))<DAY,'paid extension begins at the failed-renewal hold, not after the unpaid year');
      assert(Number(row.service_extension_days)>0,'purchased extension survives cancellation');
    }
    const paid=await makeCustomer('bought-extension-paid-'+provider);
    const healthy=await renewing(paid,year,{provider,periodEnd:fromNow(365)});
    await extend(paid,year,healthy.row);
    const end=(await get(healthy.row.id)).current_period_end;
    await lifecycle.updateProviderSubscription({provider,providerSubscriptionId:healthy.ref,providerStatus:'paused',periodEnd:end});
    await lifecycle.updateProviderSubscription({provider,providerSubscriptionId:healthy.ref,providerStatus:'cancelled',periodEnd:end});
    same((await get(healthy.row.id)).current_period_end,end,'suspension without payment-failure evidence preserves the paid base term');
  }
}

async function selection(){
  const customer=await makeCustomer('different');
  const wider=await makePlan('wider',{streams:3});
  const other=await insert(customer,wider,{end:60});
  const trialPlan=await makePlan('trial',{interval:'trial',days:3});
  const trial=await insert(customer,trialPlan,{status:'trialing',end:3});
  const unpaid=await insert(customer,half,{source:'plisio',status:'past_due',end:30});
  const bought=await renewing(customer,year);
  assert.equal(bought.row.service_extension_days,0,'different access, trials and unpaid rows are not carried');
  for(const row of [other,trial,unpaid])assert.equal((await get(row.id)).superseded_by,null);

  const sources=await makeCustomer('sources');
  for(const source of ['service_credit','admin_grant','manual'])await insert(sources,half,{source,end:9.5});
  await insert(sources,half,{source:'stripe',recurring:true,status:'cancelled',cancelAtEnd:true,start:-40,end:-1,ext:11});
  const all=await renewing(sources,year);
  assert.equal((await ledger(all.row.id)).length,4,'credit, granted, hand-made and ended auto-renew time is carried');
  assert.equal(all.row.service_extension_days,10,'four rows covering the same ten days add ten days, not forty');
  assert.equal(carriedDays(await ledger(all.row.id)),10);

  // A payment that is only approved carries nothing until it is confirmed.
  const approved=await makeCustomer('approved');
  await insert(approved,half,{end:19.5});
  const ref=`I-CARRIED${suffix}`;
  const pending=await renewing(approved,year,{provider:'paypal',ref,providerStatus:'APPROVED'});
  assert.equal((await ledger(pending.row.id)).length,0);
  await lifecycle.updateProviderSubscription({provider:'paypal',providerSubscriptionId:ref,providerStatus:'ACTIVE',periodEnd:pending.periodEnd});
  assert.equal((await get(pending.row.id)).service_extension_days,20);

  const check=(held,plan)=>carriedTime.assertCarryPossible({customerId:held.id,planId:plan.id,snapshot:contract(plan,'stripe')});
  const lifetime=await makeCustomer('lifetime');
  await insert(lifetime,half,{end:new Date('9999-01-01T00:00:00Z')});
  await assert.rejects(check(lifetime,year),{code:'CARRIED_TIME_LIFETIME'});
  await check(lifetime,wider);

  const long=await makeCustomer('limit');
  const huge=await insert(long,half,{end:3700});
  await assert.rejects(check(long,year),{code:'CARRIED_TIME_LIMIT'});
  const over=await renewing(long,year);
  assert.equal(over.row.service_extension_days,0,'nothing above the limit is carried');
  assert.equal((await get(huge.id)).superseded_by,null,'and the source is left as it was');
  assert.equal((await operatorItems(long,'carried_time_over_limit')).length,1);
}

// The database function is callable on its own, with a value ratio per source.
async function ratio(){
  const customer=await makeCustomer('ratio');
  const source=await insert(customer,half,{end:9.5});
  const target=await insert(customer,year,{source:'stripe',recurring:true,end:365});
  const days=(await query('SELECT public.carry_paid_time($1,$2,2.5) AS days',[target.id,source.id])).rows[0].days;
  assert.equal(days,24,'ceil(9.5 days x 2.5)');
  assert.equal((await query('SELECT public.carry_paid_time($1,$2,2.5) AS days',[target.id,source.id])).rows[0].days,null,'once');
}

const carriedDays=entries=>entries.filter(row=>row.status==='active').reduce((sum,row)=>sum+row.applied_days,0);

// Time held twice over is granted once, and a refund leaves whatever another
// payment still covers. A one-off is inserted first so that the stacking trigger
// does not queue it behind the overlapping row.
async function overlaps(){
  const days=async row=>(await get(row.id)).service_extension_days;

  const covering=await makeCustomer('overlap-covering');
  const paid=await insert(covering,half,{source:'stripe',start:-6,end:39.5});
  await insert(covering,half,{start:-5,end:19.5});
  await insert(covering,half,{source:'admin_grant',start:-4,end:9.5});
  const quoted=(await query('SELECT total_days FROM public.carried_time_precheck($1,$2,$3::jsonb)',[covering.id,year.id,JSON.stringify(contract(year,'stripe'))])).rows[0];
  assert.equal(Number(quoted.total_days),40,'the check before payment counts the same union');
  const first=await renewing(covering,year);
  assert.equal(await days(first.row),40);
  assert.equal((await ledger(first.row.id)).length,3,'covered rows are replaced too');
  assert.equal(carriedDays(await ledger(first.row.id)),40);
  await refund(covering,paid);
  assert.equal(await days(first.row),20,'the customer keeps what the other paid row still covers');
  assert.equal(carriedDays(await ledger(first.row.id)),20);

  const covered=await makeCustomer('overlap-covered');
  const inner=await insert(covered,half,{source:'stripe',start:-5,end:19.5});
  await insert(covered,half,{start:-6,end:39.5});
  const second=await renewing(covered,year);
  assert.equal(await days(second.row),40);
  await refund(covered,inner);
  assert.equal(await days(second.row),40,'refunding a covered payment takes nothing the other row holds');

  const partial=await makeCustomer('overlap-partial');
  const short=await insert(partial,half,{source:'stripe',start:-6,end:9.5});
  await insert(partial,half,{start:-5,end:29.5});
  const third=await renewing(partial,year);
  assert.equal(await days(third.row),30);
  assert.deepStrictEqual((await ledger(third.row.id)).map(row=>row.applied_days).sort((a,b)=>a-b),[10,20]);
  await refund(partial,short);
  assert.equal(await days(third.row),30);
  await termination.terminateForRefund(third.row.id,partial.id,{reason:'first payment refunded'});
  assert.equal(await days(third.row),0);

  // A pro-rata refund of a covered row takes nothing; of the covering row, only
  // the part no other row covers.
  // Returns a retry of the same refund.
  const proRataNow=async(customer,row)=>{
    const input={subscriptionId:row.id,customerId:customer.id,originalEnd:(await get(row.id)).current_period_end,cutoffAt:new Date(),serviceType:'emby'};
    await prepaidRefunds.applyPrepaidRefund(input);
    return()=>prepaidRefunds.applyPrepaidRefund(input);
  };
  const hidden=await makeCustomer('overlap-prorata-covered');
  const underneath=await insert(hidden,half,{source:'stripe',start:-5,end:19.5});
  await insert(hidden,half,{start:-6,end:39.5});
  const fourth=await renewing(hidden,year);
  await proRataNow(hidden,underneath);
  assert.equal(await days(fourth.row),40,'pro-rata on a fully covered row removes nothing');
  assert.equal(carriedDays(await ledger(fourth.row.id)),40);

  const topped=await makeCustomer('overlap-prorata-covering');
  const outer=await insert(topped,half,{source:'stripe',start:-6,end:29.5});
  await insert(topped,half,{start:-5,end:9.5});
  const fifth=await renewing(topped,year);
  assert.equal(await days(fifth.row),30);
  const retry=await proRataNow(topped,outer);
  assert.equal(await days(fifth.row),10,'pro-rata on the covering row removes only what nothing else covers');
  assert.equal(carriedDays(await ledger(fifth.row.id)),10);
  await retry();
  assert.equal(await days(fifth.row),10,'a retry removes nothing more');

  // Overlapping time is also counted once against the limit.
  const long=await makeCustomer('overlap-limit');
  await insert(long,half,{start:-6,end:3000});
  await insert(long,half,{source:'admin_grant',start:-5,end:2999});
  await carriedTime.assertCarryPossible({customerId:long.id,planId:year.id,snapshot:contract(year,'stripe')});
}

async function reversedCannotBeRefundedAgain(){
  const customer=await makeCustomer('refund-twice');
  const paid=await insert(customer,half,{source:'plisio',end:19.5});
  await renewing(customer,year);
  await chargeback(customer,paid);
  await assert.rejects(operatorRefund.record({customerId:customer.id,subscriptionId:paid.id,amount:'6.00',full:true,
    reason:'Refunded again by mistake',submissionId:crypto.randomUUID()}),/already been refunded or reversed/);

  // The lock is taken before an auto-renewing payment's loss is written too.
  const renewed=await makeCustomer('refund-lock');
  const bought=await renewing(renewed,year);
  const holder=await getPool().connect(),other=await getPool().connect();
  try{
    await holder.query('BEGIN');
    await holder.query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,access_action,metadata)
      VALUES('stripe',$1,$1,'refund','recorded','direct',$2,$3,'preserve','{"fullRefund":true}'::jsonb)`,[`evt_carried_lock_${suffix}`,renewed.id,bought.ref]);
    await other.query('BEGIN');
    await assert.rejects(other.query('SELECT id FROM customers WHERE id=$1 FOR KEY SHARE NOWAIT',[renewed.id]),{code:'55P03'});
  }finally{
    for(const client of [other,holder]){await client.query('ROLLBACK').catch(()=>{});client.release();}
  }
}

async function firstPaymentRecovery(){
  const customer=await makeCustomer('first-past-due');
  await insert(customer,half,{end:19.5});
  const pending=await renewing(customer,year,{providerStatus:'incomplete'});
  assert.equal((await ledger(pending.row.id)).length,0);
  await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:pending.ref,providerStatus:'active',periodEnd:pending.periodEnd});
  assert.equal((await get(pending.row.id)).service_extension_days,20,'a first payment confirmed late still adds the time');

  // A renewal recovering on an agreement that was paid at purchase moves nothing.
  const older=await makeCustomer('renewal-recovery');
  const agreement=await renewing(older,year);
  await insert(older,half,{end:19.5});
  for(const providerStatus of ['past_due','active'])await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:agreement.ref,providerStatus});
  assert.equal((await ledger(agreement.row.id)).length,0);

  const late=await makeCustomer('ended-period');
  const kept=await insert(late,half,{end:19.5});
  await renewing(late,year,{periodEnd:fromNow(-0.001)});
  assert.equal((await get(kept.id)).superseded_by,null);
  assert.equal((await operatorItems(late,'carried_time_receiving_period_ended')).length,1,'an operator is told');
}

async function suspendedAgreements(){
  const buy=async label=>{
    const customer=await makeCustomer(label);
    await insert(customer,half,{end:99.5});
    return renewing(customer,year,{provider:'paypal',ref:`I-${label}-${suffix}`});
  };
  const update=(bought,providerStatus,periodEnd)=>lifecycle.updateProviderSubscription({provider:'paypal',providerSubscriptionId:bought.ref,providerStatus,periodEnd});
  const unpaid=await buy('SUSPENDEDUNPAID');
  for(const status of ['PAST_DUE','SUSPENDED','CANCELLED'])await update(unpaid,status,fromNow(730));
  assert(Math.abs(ms((await get(unpaid.row.id)).access_end)-(Date.now()+100*DAY))<DAY,'past due, suspended, cancelled: no unpaid period');

  const paid=await buy('SUSPENDEDPAID');
  for(const status of ['SUSPENDED','CANCELLED'])await update(paid,status,paid.periodEnd);
  same((await get(paid.row.id)).current_period_end,paid.periodEnd,'a paid period is never shortened');
}

async function concurrency(){
  for(let round=0;round<5;round++){
    const customer=await makeCustomer('race');
    await insert(customer,half,{end:29.5});
    const ref=`sub_carried_race_${round}_${suffix}`,periodEnd=fromNow(365);
    const buy=()=>renewing(customer,year,{ref,periodEnd});
    const results=await Promise.allSettled([buy(),buy(),buy()]);
    assert(results.some(result=>result.status==='fulfilled'),results[0].reason?.message);
    const done=await buy();
    assert.equal(done.row.service_extension_days,30,'concurrent deliveries carry once');
    assert.equal((await ledger(done.row.id)).length,1);
  }
}

async function cleanup(){
  const remove=(sql,ids)=>query(sql,[ids]).catch(error=>console.warn('carried-time smoke cleanup incomplete:',error.message));
  for(const table of ['customer_access_holds','payment_incidents','subscription_access_extensions','subscription_time_carryovers','subscriptions']){
    await remove(`DELETE FROM ${table} WHERE customer_id=ANY($1::uuid[])`,customerIds);
  }
  await query('DELETE FROM payment_incidents WHERE customer_id IS NULL AND strpos(provider_event_id,$1)>0',[suffix]).catch(()=>{});
  await remove('DELETE FROM customers WHERE id=ANY($1::uuid[])',customerIds);
  await query('UPDATE plans SET active=FALSE,visible=FALSE WHERE id=ANY($1::uuid[])',[planIds]).catch(()=>{});
}

async function main(){
  try{
    half=await makePlan('half-year',{interval:'6_months',days:182});
    year=await makePlan('year',{interval:'year',days:365});
    await carryAndRenewals();
    await sourceRefunds();
    await databaseOnlyReversal();
    await proRata();
    await sourceExtensions();
    await firstTermAndLater();
    await pastDue();
  await purchasedExtensionsAfterUnpaidRenewal();
    await selection();
    await overlaps();
    await reversedCannotBeRefundedAgain();
    await firstPaymentRecovery();
    await suspendedAgreements();
    await ratio();
    await concurrency();
  }finally{await cleanup();}
  console.log('carried-time renewal DB smoke: ok — carry, renewals, extensions, source and first-term refunds, past due, selection and races');
}

// Exit explicitly: access reconciliation may keep handles open.
main().then(async()=>{await getPool().end();process.exit(0);}).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
