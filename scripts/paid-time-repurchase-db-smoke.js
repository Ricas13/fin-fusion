'use strict';

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('paid-time repurchase DB smoke')) process.exit(0);

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {query,transaction,getPool}=require('../src/db');
const extensions=require('../src/payments/subscription-access-extensions');
const lifecycle=require('../src/payments/lifecycle-primitives');
const prepaidRefunds=require('../src/payments/lifecycle-prepaid-refunds');
const samePlanRepurchase=require('../src/payments/same-plan-repurchase');
const checkoutIntents=require('../src/payments/checkout-intents');
const planCapacity=require('../src/entitlements/plan-capacity');
const subscriptionState=require('../src/entitlements/subscription-state');

const DAY=86400000;
const suffix=Date.now().toString(36);
const customerIds=[],planIds=[],serverIds=[];
let sequence=0;
const ms=value=>new Date(value).getTime();
const fromNow=days=>new Date(Date.now()+days*DAY);
const same=(actual,expected,message)=>assert(Math.abs(ms(actual)-ms(expected))<2,`${message} (got ${new Date(actual).toISOString()}, expected ${new Date(expected).toISOString()})`);
const startsNow=(row,message)=>assert(Math.abs(ms(row.starts_at)-Date.now())<DAY/2,`${message} (starts ${new Date(row.starts_at).toISOString()})`);
const duration=row=>ms(row.current_period_end)-ms(row.starts_at);

async function makeCustomer(label){
  const name=`paidtime-${label}-${suffix}-${++sequence}`;
  const row=(await query('INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *',[name,`${name}@example.invalid`])).rows[0];
  customerIds.push(row.id);return row;
}
async function makePlan(label,{service='emby',capacity=100,interval='month'}={}){
  const code=`paidtime-${label}-${suffix}-${++sequence}`;
  const row=(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,$2,'direct',$3,30,600,'GBP',$4,TRUE,TRUE,1,'premium') RETURNING *`,[code,service,interval,capacity])).rows[0];
  planIds.push(row.id);return row;
}
async function get(id){
  return(await query(`SELECT *,current_period_end+((COALESCE(service_extension_days,0)||' days')::interval) AS access_end FROM subscriptions WHERE id=$1`,[id])).rows[0];
}
// Inserts exactly what the database would receive; the stacking trigger decides the window.
async function insert(customer,plan,{source='stripe',ref,status='active',start=0,end=30,ext=0,cancelAtEnd=false,snapshot,recurring=false,serverId=null,location=null}={}){
  const provider=['stripe','paypal','plisio'].includes(source);
  const reference=ref!==undefined?ref:provider?`${recurring?(source==='paypal'?'I-':'sub_'):'pi_'}paidtime_${suffix}_${++sequence}`:null;
  const commercial=snapshot||(provider?{kind:'direct_plan',checkoutMode:recurring?'subscription':'payment',billingInterval:'month',durationDays:30}:{});
  const row=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,
      service_extension_days,cancel_at_period_end,billing_interval_snapshot,duration_days_snapshot,commercial_snapshot,media_server_id,media_location_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,30,$11::jsonb,$12,$13) RETURNING id`,
  [customer.id,plan.id,status,source,reference,start instanceof Date?start:fromNow(start),end instanceof Date?end:fromNow(end),ext,cancelAtEnd,plan.billing_interval,JSON.stringify(commercial),serverId,location])).rows[0];
  return get(row.id);
}
const zeroValue={source:'manual',snapshot:{kind:'direct_plan',checkoutMode:'payment',settlementKind:'fully_discounted_local',priceMinor:600,discountedMinor:0,billingInterval:'month',durationDays:30}};
async function refundIncident(row){
  await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata)
    VALUES($1,$2,$3,'refund','recorded','direct',$4,$5,600,'GBP','preserve','{"fullRefund":true,"originalAmountMinor":600}'::jsonb)`,
  [row.source,`evt_paidtime_${suffix}_${++sequence}`,`case_paidtime_${suffix}_${sequence}`,row.customer_id,row.provider_subscription_id]);
}
function purchaseContract(plan,extra={}){
  return{kind:'direct_plan',provider:'stripe',planId:plan.id,planCode:plan.code,planName:plan.name,priceMinor:600,discountedMinor:600,currency:'GBP',billingInterval:'month',durationDays:30,checkoutMode:'payment',streams:1,serverClass:'premium',accessVariantKind:'streams',accessQuantity:1,...extra};
}
const activate=(customer,plan,ref,extra={})=>lifecycle.activatePurchase({customerId:customer.id,planId:plan.id,provider:'stripe',providerSubscriptionId:ref,providerStatus:'active',commercialSnapshot:purchaseContract(plan,extra)});
async function assertNoOverlap(customer,message){
  const rows=(await query(`SELECT starts_at,current_period_end+((COALESCE(service_extension_days,0)||' days')::interval) AS access_end
    FROM subscriptions WHERE customer_id=$1 AND superseded_by IS NULL AND status='active' ORDER BY starts_at`,[customer.id])).rows;
  for(let i=1;i<rows.length;i++)assert(ms(rows[i].starts_at)>=ms(rows[i-1].access_end)-1,`${message}: purchase ${i+1} overlaps the one before it`);
  return rows;
}

async function triggerOrder(){
  const names=(await query(`SELECT tgname FROM pg_trigger WHERE tgrelid='public.subscriptions'::regclass AND NOT tgisinternal AND (tgtype & 2)=2 AND (tgtype & 4)=4 ORDER BY tgname`)).rows.map(row=>row.tgname);
  const stack=names.indexOf('trg_stack_prepaid_subscription_window');
  for(const earlier of ['snapshot_subscription_plan_terms_trigger','subscriptions_billing_mode_normalize','subscriptions_free_tier_non_expiring','subscriptions_money_loss_terminal']){
    assert(names.indexOf(earlier)>=0&&names.indexOf(earlier)<stack,`stacking must run after ${earlier}: ${names.join(', ')}`);
  }
}

async function queueing(){
  const plan=await makePlan('queue');
  // G1 and G6: extension days count, also on rows that live only on them.
  for(const status of ['active','cancelled','expired']){
    const customer=await makeCustomer(`ext-${status}`);
    const first=await insert(customer,plan,{status,start:-20,end:status==='active'?10:-2,ext:15});
    const next=await insert(customer,plan);
    same(next.starts_at,first.access_end,`G1/G6 ${status}: a repurchase starts after the extension days`);
    const expected=(await query(`SELECT $1::timestamptz+INTERVAL '1 month' AS t`,[next.starts_at])).rows[0].t;
    same(next.current_period_end,expected,'the queued purchase keeps its full calendar term');
  }
  // G2 and G5: other paid time that must be queued behind.
  const protectedRows={
    migration:{source:'migration'},serviceCredit:{source:'service_credit'},zeroValue,
    endingStripe:{recurring:true,cancelAtEnd:true},endingPaypal:{source:'paypal',recurring:true,cancelAtEnd:true}
  };
  for(const [label,fixture] of Object.entries(protectedRows)){
    const customer=await makeCustomer(label);
    const first=await insert(customer,plan,{...fixture,start:-5,end:40});
    const next=await insert(customer,plan,{source:'paypal'});
    same(next.starts_at,first.access_end,`${label}: remaining paid time is kept`);
  }
  // Not paid time: the new purchase starts immediately, as before.
  const unprotected={
    adminGrant:{source:'admin_grant'},handMade:{source:'manual'},invitation:{source:'invitation'},
    renewingRecurring:{recurring:true},lifetime:{source:'migration',end:new Date('9999-01-01T00:00:00Z')}
  };
  for(const [label,fixture] of Object.entries(unprotected)){
    const customer=await makeCustomer(label);
    await insert(customer,plan,{end:40,...fixture,start:-5});
    startsNow(await insert(customer,plan),`${label} must not delay a purchase`);
  }
  const trialPlan=await makePlan('trial',{interval:'trial'}),trialCustomer=await makeCustomer('trial');
  await insert(trialCustomer,trialPlan,{source:'migration',status:'trialing',end:3});
  startsNow(await insert(trialCustomer,plan),'an imported trial must not delay a purchase');

  const jellyfin=await makePlan('lane-jf',{service:'jellyfin'}),stremio=await makePlan('lane-st',{service:'stremio'}),bundle=await makePlan('lane-bundle',{service:'bundle'});
  const lanes=await makeCustomer('lanes');
  const embyTime=await insert(lanes,plan,{source:'migration',end:90});
  startsNow(await insert(lanes,jellyfin),'another service lane is independent');
  const laneTwo=await makeCustomer('lanes-bundle');
  const stremioTime=await insert(laneTwo,stremio,{source:'migration',end:50});
  same((await insert(laneTwo,bundle)).starts_at,stremioTime.access_end,'a bundle shares the Stremio lane');
  assert(ms(embyTime.access_end)>Date.now());

  const free=(await query(`SELECT * FROM plans WHERE is_free_tier=TRUE AND service_type='jellyfin' AND COALESCE(is_addon,FALSE)=FALSE ORDER BY created_at,id LIMIT 1`)).rows[0];
  if(free){
    const customer=await makeCustomer('free');
    await insert(customer,free,{source:'migration'});
    startsNow(await insert(customer,jellyfin),'free access, even imported, must never delay a paid purchase');
  }

  // G4: a new zero-value purchase queues; recurring, imported and granted rows never move.
  const customer=await makeCustomer('new-rows');
  const base=await insert(customer,plan,{source:'migration',end:40});
  same((await insert(customer,plan,zeroValue)).starts_at,base.access_end,'G4: a fully discounted purchase keeps remaining time');
  startsNow(await insert(customer,plan,{recurring:true}),'recurring periods stay provider-authoritative');
  startsNow(await insert(customer,plan,{source:'migration'}),'new imported rows are never moved');
  startsNow(await insert(customer,plan,{source:'admin_grant'}),'new admin grants are never moved');
}

async function activation(){
  const plan=await makePlan('activate'),customer=await makeCustomer('activate');
  const imported=await insert(customer,plan,{source:'migration',start:-5,end:60});
  const ref=`pi_paidtime_activate_${suffix}`;
  const bought=await activate(customer,plan,ref);
  same(bought.starts_at,imported.access_end,'activation queues behind imported time');
  const effective=await subscriptionState.effectiveEmbySubscription(customer.id,{includeBlocked:true});
  assert.equal(String(effective?.subscription_id),String(imported.id),'a queued purchase does not take over early');
  const replayed=await activate(customer,plan,ref);
  assert.equal(replayed.id,bought.id,'provider replay returns the same row');
  same(replayed.starts_at,bought.starts_at,'provider replay does not queue the purchase again');

  await Promise.all(['a','b'].map(key=>activate(customer,plan,`pi_paidtime_race_${key}_${suffix}`)));
  assert.equal((await assertNoOverlap(customer,'concurrent activations')).length,4);
}

async function extensionMovement(){
  const plan=await makePlan('extend'),customer=await makeCustomer('extend');
  const current=await insert(customer,plan,{start:-10,end:20});
  const second=await insert(customer,plan),third=await insert(customer,plan);
  const contract=purchaseContract(plan,{kind:'subscription_extension',extensionSubscriptionId:current.id});
  const ref=`pi_paidtime_extend_${suffix}`;
  const apply=()=>transaction(client=>extensions.applyPurchase(client,{customerId:customer.id,subscriptionId:current.id,planId:plan.id,provider:'stripe',providerPaymentId:ref,commercialSnapshot:contract}));
  await apply();
  const longer=await get(current.id),secondAfter=await get(second.id),thirdAfter=await get(third.id);
  assert(ms(longer.access_end)>ms(current.access_end));
  same(secondAfter.starts_at,longer.access_end,'G7: queued purchase moves behind the bought time');
  same(thirdAfter.starts_at,secondAfter.access_end,'G7: the whole chain moves');
  assert(Math.abs(duration(secondAfter)-duration(second))<2&&Math.abs(duration(thirdAfter)-duration(third))<2,'moving never changes a purchased duration');
  assert.equal((await apply()).replay,true);
  same((await get(second.id)).starts_at,secondAfter.starts_at,'replay does not move the queue twice');

  await extensions.revokeByProviderPayment({provider:'stripe',providerPaymentId:ref,customerId:customer.id,reason:'smoke refund'});
  same((await get(second.id)).starts_at,second.starts_at,'revoking returns the queue');
  same((await get(third.id)).starts_at,third.starts_at,'revoking returns the whole queue');
  await extensions.revokeByProviderPayment({provider:'stripe',providerPaymentId:ref,customerId:customer.id,reason:'smoke refund replay'});
  same((await get(second.id)).starts_at,second.starts_at,'revoke replay moves nothing');

  // An extension applied before this change never moved the queue. Revoking it
  // must not pull purchases into time the holder still has.
  const oldRef=`pi_paidtime_legacy_${suffix}`;
  // Read as text: a JavaScript Date would drop the microseconds that make a
  // queued start equal to the previous end.
  const exact=(await query('SELECT id,starts_at::text AS starts,current_period_end::text AS ends FROM subscriptions WHERE id=ANY($1::uuid[])',[[second.id,third.id]])).rows;
  await transaction(client=>extensions.applyPurchase(client,{customerId:customer.id,subscriptionId:current.id,planId:plan.id,provider:'stripe',providerPaymentId:oldRef,commercialSnapshot:contract}));
  for(const row of exact)await query('UPDATE subscriptions SET starts_at=$2::timestamptz,current_period_end=$3::timestamptz WHERE id=$1',[row.id,row.starts,row.ends]);
  await extensions.revokeByProviderPayment({provider:'stripe',providerPaymentId:oldRef,customerId:customer.id,reason:'legacy refund'});
  same((await get(second.id)).starts_at,second.starts_at,'a never-moved queue is not pulled into current access');
  await assertNoOverlap(customer,'after legacy revoke');

  await Promise.all([
    activate(customer,plan,`pi_paidtime_both_ext_${suffix}`,{kind:'subscription_extension',extensionSubscriptionId:current.id}),
    activate(customer,plan,`pi_paidtime_both_new_${suffix}`)
  ]);
  assert.equal((await assertNoOverlap(customer,'concurrent extension and purchase')).length,4);
}

async function refunds(){
  const plan=await makePlan('refund'),customer=await makeCustomer('refund-queued');
  const first=await insert(customer,plan,{start:-5,end:25});
  const refunded=await insert(customer,plan);
  await query('UPDATE subscriptions SET service_extension_days=5 WHERE id=$1',[refunded.id]);
  const later=await insert(customer,plan);
  same(later.starts_at,(await get(refunded.id)).access_end,'fixture: the later purchase queues behind extension days');
  await refundIncident(refunded);
  assert.equal((await get(refunded.id)).status,'expired');
  const moved=await get(later.id);
  same(moved.starts_at,first.access_end,'refunding a queued purchase closes exactly its slot');
  assert(Math.abs(duration(moved)-duration(later))<2,'a refund removes only its own time');
  await refundIncident(refunded);
  same((await get(later.id)).starts_at,moved.starts_at,'a second refund event moves nothing');

  const other=await makeCustomer('refund-import');
  await insert(other,plan,{start:-5,end:25});
  const queued=await insert(other,plan);
  const imported=await insert(other,plan,{source:'migration',end:200});
  const behindImport=await insert(other,plan);
  same(behindImport.starts_at,imported.access_end,'fixture: queued behind imported time');
  await refundIncident(queued);
  same((await get(behindImport.id)).starts_at,behindImport.starts_at,'a refund never moves a purchase into other paid time');

  const proRata=await makeCustomer('refund-prorata');
  const active=await insert(proRata,plan,{start:-10,end:20});
  await query('UPDATE subscriptions SET service_extension_days=5 WHERE id=$1',[active.id]);
  const waiting=await insert(proRata,plan);
  const cutoffAt=new Date();
  const input={subscriptionId:active.id,customerId:proRata.id,originalEnd:active.current_period_end,cutoffAt,serviceType:'emby'};
  await prepaidRefunds.applyPrepaidRefund(input);
  const pulled=await get(waiting.id);
  assert(Math.abs(ms(pulled.starts_at)-cutoffAt.getTime())<5000,'the queue moves up to the refund, over base term and extension days');
  assert(Math.abs(duration(pulled)-duration(waiting))<2);
  await prepaidRefunds.applyPrepaidRefund(input);
  same((await get(waiting.id)).starts_at,pulled.starts_at,'refund recovery does not move the queue twice');
}

async function jellyfinServer(label){
  const slug=`paidtime-${label}-${suffix}`;
  const row=(await query(`INSERT INTO jellyfin_servers(name,slug,server_class,media_server_type,base_url,api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,health_status,last_health_check,placement_mode,location)
    VALUES($1,$1,'premium','jellyfin',$2,'key',TRUE,TRUE,TRUE,TRUE,1,20,'healthy',NOW(),'active','London') RETURNING id`,[slug,`https://${slug}.invalid`])).rows[0];
  serverIds.push(row.id);return row;
}

async function capacityPlacementAndDecisions(){
  const server=await jellyfinServer('capacity');
  const plan=await makePlan('capacity',{service:'jellyfin',capacity:1});
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)',[plan.id,server.id]);
  const holder=await makeCustomer('holder');
  const current=await insert(holder,plan,{start:-1,end:10,serverId:server.id,location:'London'});
  assert.equal((await planCapacity.usage(plan.id)).soldOut,true,'fixture: the holder fills the plan');
  assert.deepStrictEqual(await samePlanRepurchase.assessRepurchase(holder.id,plan),{subscriptionId:current.id,queueProtects:true});
  const intent=extra=>checkoutIntents.createIntent({scope:'customer',customerId:holder.id,planId:plan.id,provider:'stripe',checkoutMode:'payment',ttlMinutes:30,commercialSnapshot:purchaseContract(plan,extra)});
  await assert.rejects(intent({}),error=>error?.code==='PLAN_CAPACITY_EXHAUSTED','a direct repurchase of a full plan is refused before money is taken');
  assert((await intent({kind:'subscription_extension',extensionSubscriptionId:current.id})).id,'the holder can still extend');
  assert.equal(Number((await planCapacity.usage(plan.id)).planUsed),1,'extending takes no new place');

  const queued=await insert(holder,plan,{snapshot:{kind:'direct_plan',checkoutMode:'payment',mediaLocation:'London',billingInterval:'month',durationDays:30}});
  assert.equal(String(queued.media_server_id),String(server.id),'a queued repurchase keeps the occupied server');
  assert.equal(Number((await planCapacity.usage(plan.id)).planUsed),1,'a queued purchase takes no place before it starts');
  assert.equal(await samePlanRepurchase.assessRepurchase(holder.id,plan),null,'with a queued purchase the direct path stays');
  const elsewhere=await insert(holder,plan,{snapshot:{kind:'direct_plan',checkoutMode:'payment',mediaLocation:'Elsewhere',billingInterval:'month',durationDays:30}});
  assert.equal(elsewhere.media_server_id,null,'a deliberately different location is not overridden');

  const emby=await makePlan('decide'),target=await makePlan('decide-target');
  for(const [label,fixture,protects] of [['renewing',{recurring:true},false],['imported',{source:'migration'},true],['handmade',{source:'manual'},false]]){
    const customer=await makeCustomer(`decide-${label}`);
    const row=await insert(customer,emby,{...fixture,start:-1,end:20});
    assert.deepStrictEqual(await samePlanRepurchase.assessRepurchase(customer.id,emby),{subscriptionId:row.id,queueProtects:protects},label);
    if(label==='renewing'){
      await query(`INSERT INTO customer_plan_changes(customer_id,current_subscription_id,target_plan_id,provider,mode,state,effective_at)
        VALUES($1,$2,$3,'stripe','period_end','pending',NOW()+INTERVAL '20 days')`,[customer.id,row.id,target.id]);
      assert.equal(await samePlanRepurchase.assessRepurchase(customer.id,emby),null,'an open plan change keeps the direct path');
    }
  }
}

async function report(){
  const sql=fs.readFileSync(path.join(__dirname,'..','docs','paid-time-overlap-report.sql'),'utf8');
  const plan=await makePlan('report');
  const recurringOver=await makeCustomer('report-recurring');
  await insert(recurringOver,plan,{source:'migration',start:-10,end:224});
  await insert(recurringOver,plan,{recurring:true,start:0,end:365});
  const samePlan=await makeCustomer('report-same');
  await insert(samePlan,plan,{start:-5,end:25});
  await insert(samePlan,plan,{source:'migration',start:0,end:30});
  const promo=await makeCustomer('report-promo');
  await insert(promo,plan,{...zeroValue,start:-5,end:25});
  await insert(promo,plan,{source:'migration',start:0,end:30});
  const expired=await makeCustomer('report-expired');
  const ended=await insert(expired,plan,{status:'expired',start:-40,end:-10});
  await query(`INSERT INTO subscription_access_extensions(customer_id,subscription_id,plan_id,provider,provider_payment_id,purchased_days,applied_days)
    VALUES($1,$2,$3,'stripe',$4,20,20)`,[expired.id,ended.id,plan.id,`pi_paidtime_report_${suffix}`]);
  await insert(expired,plan,{start:-10,end:20});
  const clean=await makeCustomer('report-clean');
  await insert(clean,plan,{start:-5,end:25});
  await insert(clean,plan);

  const client=await getPool().connect();
  let rows;
  try{await client.query('BEGIN READ ONLY');rows=(await client.query(sql)).rows;}
  finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  const found=customer=>rows.find(row=>row.customer_id===customer.id);
  const close=(customer,days,kind)=>{
    const row=found(customer);assert(row,`report must list ${customer.display_name}`);
    assert(Math.abs(Number(row.total_days_lost)-days)<0.1,`${customer.display_name}: lost ${row.total_days_lost}, expected ${days}`);
    assert.equal(row.overlap_kinds,kind);return row;
  };
  close(recurringOver,224,'recurring_over_nonrecurring');
  close(samePlan,25,'same_plan');
  assert.equal(close(promo,25,'same_plan').involves_zero_value_promo,false,'the flag describes the losing rows');
  close(expired,20,'same_plan');
  assert.equal(found(clean),undefined,'queued purchases are not a loss');
}

async function cleanup(){
  try{
    for(const table of ['payment_incidents','billing_checkout_intents','customer_plan_changes','jellyfin_server_placement_leases','subscription_access_extensions','subscriptions']){
      await query(`DELETE FROM ${table} WHERE customer_id=ANY($1::uuid[])`,[customerIds]);
    }
    await query('DELETE FROM customers WHERE id=ANY($1::uuid[])',[customerIds]);
    await query('DELETE FROM plan_server_eligibility WHERE plan_id=ANY($1::uuid[])',[planIds]);
  }catch(error){console.warn('paid-time smoke cleanup incomplete:',error.message);}
  await query('UPDATE jellyfin_servers SET enabled=FALSE WHERE id=ANY($1::uuid[])',[serverIds]).catch(()=>{});
  await query('UPDATE plans SET active=FALSE,visible=FALSE WHERE id=ANY($1::uuid[])',[planIds]).catch(()=>{});
}

async function main(){
  try{
    await triggerOrder();
    await queueing();
    await activation();
    await extensionMovement();
    await refunds();
    await capacityPlacementAndDecisions();
    await report();
  }finally{await cleanup();}
  console.log('paid-time repurchase DB smoke: ok — queueing, activation replay and races, bought-time movement, refunds, capacity, placement and read-only report');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
