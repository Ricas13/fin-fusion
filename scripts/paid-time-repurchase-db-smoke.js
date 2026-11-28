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
const {REQUIRED_FUNCTIONS}=require('../src/db-compatibility-migrations');
const health=require('../src/platform/health');
const queuedPurchases=require('../src/payments/queued-purchases');
const billingControl=require('../src/payments/billing-control');
const termination=require('../src/payments/subscription-termination');
const adminActions=require('../src/access/admin-customer-individual-action-service');

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
async function makePlan(label,{service='emby',capacity=100,interval='month',streams=1,serverClass='premium'}={}){
  const code=`paidtime-${label}-${suffix}-${++sequence}`;
  const row=(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,$2,'direct',$3,30,600,'GBP',$4,TRUE,TRUE,$5,$6) RETURNING *`,[code,service,interval,capacity,streams,serverClass])).rows[0];
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
// Written the way a web process records it, including one that predates this
// change. A repeated eventId is a duplicate delivery; owned=false is an event
// whose customer was not resolved.
async function refundIncident(row,{eventId=`evt_paidtime_${suffix}_${++sequence}`,full=true,owned=true,db=query}={}){
  await db(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata)
    VALUES($1,$2,$3,'refund','recorded',$4,$5,$6,600,'GBP','preserve',$7::jsonb)
    ON CONFLICT(provider,provider_event_id,incident_type) DO NOTHING`,
  [row.source,eventId,`case_${eventId}`,owned?'direct':'unresolved',owned?row.customer_id:null,row.provider_subscription_id,JSON.stringify({fullRefund:full,originalAmountMinor:600})]);
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

// This smoke connects as the schema owner, so prove the runtime roles' access
// explicitly: take it away, re-run the repeatable migration, and look again.
// Everything, including any role created here, is rolled back.
async function runtimePrivileges(){
  const roles=['steamfusion_app','steamfusion_automation'];
  const bodies=['20261127150000_paid_time_survives_repurchase.sql','20261128120000_carried_paid_time_on_auto_renewal.sql']
    .map(file=>fs.readFileSync(path.join(__dirname,'..','db','migrations',file),'utf8')
      .replace(/^\s*BEGIN\s*;/im,'').replace(/COMMIT\s*;\s*$/i,''));
  const client=await getPool().connect();
  const allowed=async(role,signature)=>(await client.query(`SELECT has_function_privilege($1,to_regprocedure($2)::oid,'EXECUTE') AS ok`,[role,signature])).rows[0].ok;
  try{
    await client.query('BEGIN');
    for(const signature of REQUIRED_FUNCTIONS){
      assert((await client.query('SELECT to_regprocedure($1) AS found',[signature])).rows[0].found,`${signature} must exist`);
    }
    for(const role of roles){
      if(!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await client.query(`CREATE ROLE ${role} NOLOGIN`);
    }
    for(const signature of REQUIRED_FUNCTIONS)await client.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, ${roles.join(', ')}`);
    assert.equal(await allowed(roles[0],REQUIRED_FUNCTIONS[0]),false,'fixture: access was removed');
    for(const body of bodies)await client.query(body);
    for(const role of roles)for(const signature of REQUIRED_FUNCTIONS){
      assert.equal(await allowed(role,signature),true,`${role} must be able to execute ${signature}`);
    }
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
}

async function queueing(){
  const plan=await makePlan('queue');
  // G1 and G6: extension days count, also on rows that live only on them.
  for(const status of ['active','cancelled','expired']){
    const customer=await makeCustomer(`ext-${status}`);
    const first=await insert(customer,plan,{status,start:-20,end:status==='active'?10:-2,ext:15});
    const next=await insert(customer,plan);
    same(next.starts_at,first.access_end,`G1/G6 ${status}: a repurchase starts after the extension days`);
    const visible=await queuedPurchases.listForCustomer(customer.id);
    assert.deepStrictEqual(visible.map(row=>row.subscription_id),[next.id],'only the confirmed future purchase appears');
    same(visible[0].starts_at,next.starts_at,'portal uses stored queue start');
    same(visible[0].access_expires_at,next.access_end,'portal uses stored queue end');
    const outsider=await makeCustomer('queue-private');
    assert.deepStrictEqual(await queuedPurchases.listForCustomer(outsider.id),[],'queued purchases are customer scoped');
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
  await insert(laneTwo,stremio,{source:'migration',end:50});
  startsNow(await insert(laneTwo,bundle),'a bundle is broader than imported Stremio time, so the upgrade is not delayed');
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

// Newly counted time only holds back a purchase that gives no more than it does.
// Upgrades behave exactly as before this change.
async function upgrades(){
  const legacy=await makePlan('legacy',{streams:3});
  const equal=await makePlan('equal',{streams:3}),lower=await makePlan('lower',{streams:1});
  const higher=await makePlan('higher',{streams:5}),otherClass=await makePlan('class',{streams:3,serverClass:'custom'});
  const held={source:'migration',start:-5,end:200};
  for(const [label,plan,waits] of [['equal',equal,true],['lower',lower,true],['higher',higher,false],['class',otherClass,false]]){
    for(const purchase of [{},zeroValue]){
      const customer=await makeCustomer('up-'+label);
      const imported=await insert(customer,legacy,held);
      const bought=await insert(customer,plan,purchase);
      if(waits)same(bought.starts_at,imported.access_end,label+': another plan with no more access waits for imported time');
      else startsNow(bought,label+': an upgrade is not delayed by imported time');
    }
  }
  const same_=await makeCustomer('up-same');
  const smaller=await insert(same_,legacy,held);
  const wider=await insert(same_,legacy,{snapshot:{kind:'direct_plan',checkoutMode:'payment',streams:6,billingInterval:'month',durationDays:30}});
  same(wider.starts_at,smaller.access_end,'the same plan always waits, whatever the allowance');

  const single=await makePlan('single',{service:'jellyfin'}),bundle=await makePlan('wide',{service:'bundle'});
  const narrow=await makeCustomer('up-narrow');
  await insert(narrow,bundle,held);
  startsNow(await insert(narrow,single),'a different service is treated as an upgrade, even a narrower one');

  // Provider one-off anchors keep the previous rule: base term only for upgrades.
  const customer=await makeCustomer('up-provider');
  const first=await insert(customer,legacy,{start:-5,end:20,ext:10});
  const upgrade=await insert(customer,higher);
  same(upgrade.starts_at,first.current_period_end,'an upgrade queues behind the base term as before, not behind extension days');
  assert.equal((await insert(customer,higher,zeroValue)).starts_at>=upgrade.access_end,true,'a later zero-value purchase of that upgrade waits for it');
  const zeroUpgrade=await makeCustomer('up-zero');
  await insert(zeroUpgrade,legacy,{start:-5,end:20});
  startsNow(await insert(zeroUpgrade,higher,zeroValue),'a zero-value upgrade was never queued behind provider time');

  // Moving the queue follows the same rule.
  const moving=await makeCustomer('up-move');
  const current=await insert(moving,legacy,{start:-5,end:20});
  const queuedUpgrade=await insert(moving,higher);
  await query('UPDATE subscriptions SET service_extension_days=10 WHERE id=$1',[current.id]);
  await query('SELECT public.shift_prepaid_queue_after_end_change($1,0)',[current.id]);
  same((await get(queuedUpgrade.id)).starts_at,queuedUpgrade.starts_at,'bought time does not delay a queued upgrade');
  await query('UPDATE subscriptions SET service_extension_days=0 WHERE id=$1',[current.id]);
  await query('SELECT public.shift_prepaid_queue_after_end_change($1,10)',[current.id]);
  same((await get(queuedUpgrade.id)).starts_at,queuedUpgrade.starts_at,'removing it does not pull the upgrade into the current term');
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

// A full-refund event must hold the customer FOR UPDATE from before its row is
// written; a partial refund takes no more than its foreign key does.
async function refundInsertLock(){
  const plan=await makePlan('refund-lock');
  for(const [full,owned] of [[true,true],[true,false],[false,true]]){
    const customer=await makeCustomer('refund-lock');
    const started=await insert(customer,plan,{start:-5,end:25});
    const holder=await getPool().connect(),other=await getPool().connect();
    try{
      await holder.query('BEGIN');
      await refundIncident(started,{full,owned,db:(sql,params)=>holder.query(sql,params)});
      await other.query('BEGIN');
      const probe=other.query('SELECT id FROM customers WHERE id=$1 FOR KEY SHARE NOWAIT',[customer.id]);
      if(full)await assert.rejects(probe,error=>error.code==='55P03','a full refund holds the customer lock');
      else assert.equal((await probe).rowCount,1,'a partial refund does not');
    }finally{
      for(const client of [other,holder]){await client.query('ROLLBACK').catch(()=>{});client.release();}
    }
  }
}

// Refunds, provider updates and activations for one customer share a lock order.
async function lockOrder(){
  const plan=await makePlan('locks');
  const plannedRefusal=error=>{
    // Another refund or the extension may move this row first; that is a planned
    // refusal, never a deadlock.
    assert(error.code!=='40P01'&&!/deadlock/i.test(error.message),error.message);
  };
  for(let round=0;round<8;round++){
    const customer=await makeCustomer('locks');
    const current=await insert(customer,plan,{start:-5,end:25});
    const refundedByEvent=await insert(customer,plan),refundedByOperator=await insert(customer,plan);
    await Promise.all([
      activate(customer,plan,`pi_paidtime_lock_${round}_${suffix}`,{kind:'subscription_extension',extensionSubscriptionId:current.id}),
      refundIncident(refundedByEvent),
      prepaidRefunds.applyPrepaidRefund({subscriptionId:refundedByOperator.id,customerId:customer.id,originalEnd:refundedByOperator.current_period_end,cutoffAt:refundedByOperator.starts_at,serviceType:'emby'})
        .catch(plannedRefusal)
    ]);
    await assertNoOverlap(customer,'after concurrent refunds and extension');
  }
  // Two refund events for one customer arrive together.
  for(let round=0;round<10;round++){
    const customer=await makeCustomer('two-refunds');
    const current=await insert(customer,plan,{start:-5,end:25});
    const one=await insert(customer,plan),two=await insert(customer,plan),kept=await insert(customer,plan);
    await Promise.all([refundIncident(one),refundIncident(two,{owned:round%2===0})]);
    same((await get(kept.id)).starts_at,current.access_end,'both refunded slots are closed, without a deadlock');
  }
  // Three events at once, one of them delivered twice.
  for(let round=0;round<5;round++){
    const customer=await makeCustomer('many-refunds');
    const current=await insert(customer,plan,{start:-5,end:25});
    const refunded=[await insert(customer,plan),await insert(customer,plan),await insert(customer,plan)];
    const kept=await insert(customer,plan);
    const eventId=`evt_paidtime_twice_${round}_${suffix}`;
    await Promise.all([refundIncident(refunded[0],{eventId}),refundIncident(refunded[0],{eventId}),refundIncident(refunded[1]),refundIncident(refunded[2])]);
    same((await get(kept.id)).starts_at,current.access_end,'each refunded slot is closed exactly once');
    assert(Math.abs(duration(await get(kept.id))-duration(kept))<2,'durations are kept');
  }
  // Everything that writes this customer's queue at the same time.
  for(let round=0;round<8;round++){
    const customer=await makeCustomer('all-writers');
    const current=await insert(customer,plan,{start:-5,end:25});
    const first=await insert(customer,plan),second=await insert(customer,plan),third=await insert(customer,plan);
    const extensionRef=`pi_paidtime_all_${round}_${suffix}`;
    const extend=()=>activate(customer,plan,extensionRef,{kind:'subscription_extension',extensionSubscriptionId:current.id});
    const update=()=>lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:current.provider_subscription_id,providerStatus:'active'});
    await Promise.all([
      extend(),update(),refundIncident(first),refundIncident(third),
      prepaidRefunds.applyPrepaidRefund({subscriptionId:second.id,customerId:customer.id,originalEnd:second.current_period_end,cutoffAt:second.starts_at,serviceType:'emby'}).catch(plannedRefusal),
      update()
    ]);
    await Promise.all([extend(),update(),refundIncident(first)]);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM subscription_access_extensions WHERE customer_id=$1',[customer.id])).rows[0].n,1,'the replay adds no time');
    await assertNoOverlap(customer,'after every writer at once');
  }
  // A provider update racing the replay of the payment that created the row.
  for(let round=0;round<8;round++){
    const customer=await makeCustomer('update-replay'),ref=`pi_paidtime_replay_${round}_${suffix}`;
    const bought=await activate(customer,plan,ref);
    await Promise.all([
      activate(customer,plan,ref),
      lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:ref,providerStatus:'active'}),
      activate(customer,plan,ref)
    ]);
    same((await get(bought.id)).starts_at,bought.starts_at,'neither moves the purchase');
  }
}

// The operator actions move the queue in their own transaction.
async function operatorEdits(){
  const plan=await makePlan('operator',{service:'jellyfin'}),customer=await makeCustomer('operator');
  const current=await insert(customer,plan,{start:-5,end:40});
  const queued=await insert(customer,plan),later=await insert(customer,plan);
  const follows=async label=>{
    const anchor=await get(current.id),next=await get(queued.id),last=await get(later.id);
    same(next.starts_at,anchor.access_end,label+': the queue follows the new end');
    same(last.starts_at,next.access_end,label+': the whole queue follows');
    assert(Math.abs(duration(next)-duration(queued))<2&&Math.abs(duration(last)-duration(later))<2,label+': durations are kept');
  };
  await adminActions.extend({customerId:customer.id,actorUserId:null,subscriptionId:current.id,operationId:`paidtime-${suffix}`,units:1});
  assert(ms((await get(current.id)).access_end)>ms(current.access_end));
  await follows('operator extension');
  const day=offset=>new Date(Date.now()+offset*DAY).toISOString().slice(0,10);
  await adminActions.setExpiry({customerId:customer.id,actorUserId:null,subscriptionId:current.id,expiryDate:day(20)});
  await follows('earlier expiry');
  await adminActions.setExpiry({customerId:customer.id,actorUserId:null,subscriptionId:current.id,expiryDate:day(120)});
  await follows('later expiry');
  const before=await get(queued.id);
  await adminActions.setExpiry({customerId:customer.id,actorUserId:null,subscriptionId:current.id,expiryDate:'9999-01-01'});
  same((await get(queued.id)).starts_at,before.starts_at,'a lifetime end never pushes a purchase out of reach');
}

// Resuming renewal over a queued purchase would charge twice for one period.
async function resumeRenewal(){
  const plan=await makePlan('resume'),customer=await makeCustomer('resume');
  const ending=await insert(customer,plan,{recurring:true,cancelAtEnd:true,start:-5,end:20});
  assert.equal(await queuedPurchases.hasPurchaseQueuedBehind(ending.id),false);
  const waiting=await insert(customer,plan);
  same(waiting.starts_at,ending.access_end,'fixture: queued behind the ending agreement');
  assert.equal(await queuedPurchases.hasPurchaseQueuedBehind(ending.id),true);
  let providerCalls=0;
  const adapter={resumeRenewal:async()=>{providerCalls++;},stopRenewal:async()=>{providerCalls++;},fetchRemote:async()=>{providerCalls++;return null;}};
  await assert.rejects(billingControl.setRenewal(ending.id,true,null,{adapter}),error=>error.message===queuedPurchases.RESUME_BLOCKED);
  assert.equal(providerCalls,0,'refused before the provider is called');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM provider_operations WHERE owner_id=$1',[customer.id])).rows[0].n,0);
}

// A converted repurchase whose extension can no longer be applied.
async function convertedSettlement(){
  const plan=await makePlan('converted');
  const settle=async({label,fixture,reason})=>{
    const customer=await makeCustomer('converted-'+label);
    const current=await insert(customer,plan,{start:-5,end:20,...fixture});
    const snapshot=purchaseContract(plan,{kind:'subscription_extension',extensionSubscriptionId:current.id,repurchaseReason:reason});
    const intent=await checkoutIntents.createIntent({scope:'customer',customerId:customer.id,planId:plan.id,provider:'stripe',checkoutMode:'payment',ttlMinutes:30,commercialSnapshot:snapshot});
    const ref=`pi_paidtime_converted_${label}_${suffix}`;
    // The held allowance changes while the customer is paying.
    await query(`UPDATE subscriptions SET commercial_snapshot=commercial_snapshot||'{"accessQuantity":3}'::jsonb WHERE id=$1`,[current.id]);
    const run=()=>activate(customer,plan,ref,{...snapshot,checkoutIntentId:intent.id});
    const rows=async()=>(await query('SELECT * FROM subscriptions WHERE customer_id=$1 AND provider_subscription_id=$2',[customer.id,ref])).rows;
    return{customer,current,intent,run,rows};
  };
  const full=await settle({label:'full',fixture:{},reason:'plan_full'});
  const bought=await full.run();
  same(bought.starts_at,full.current.access_end,'activated as a queued purchase');
  assert.equal((await full.run()).id,bought.id,'replay returns the same purchase');
  assert.equal((await full.rows()).length,1);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM subscription_access_extensions WHERE customer_id=$1',[full.customer.id])).rows[0].n,0);
  assert.equal((await query('SELECT commercial_snapshot FROM billing_checkout_intents WHERE id=$1',[full.intent.id])).rows[0].commercial_snapshot.kind,'direct_plan');

  for(const [label,fixture,reason] of [['unprotected',{recurring:true},'unprotected'],['turned-unprotected',{recurring:true},'plan_full']]){
    const failed=await settle({label,fixture,reason});
    await assert.rejects(failed.run(),error=>error?.code==='ACCESS_EXTENSION_ALLOWANCE_CHANGED'&&error.paidButUnfulfilled===true,label);
    assert.equal((await failed.rows()).length,0,label+': no purchase over unprotected time');
    const incident=(await query(`SELECT metadata FROM payment_incidents WHERE customer_id=$1 AND incident_type='checkout_completion' AND incident_status='open'`,[failed.customer.id])).rows[0];
    assert.equal(incident?.metadata.reason,reason+'_repurchase_extension_failed',label);
    assert.equal(incident.metadata.extensionSubscriptionId,failed.current.id);
  }
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
  assert.deepStrictEqual(await samePlanRepurchase.assessHolding(holder.id,plan.id),{current:true,lifetime:false,unprotectedIds:[]});
  assert.deepStrictEqual(await samePlanRepurchase.extensionTarget(holder.id,plan),{subscriptionId:current.id});
  const intent=extra=>checkoutIntents.createIntent({scope:'customer',customerId:holder.id,planId:plan.id,provider:'stripe',checkoutMode:'payment',ttlMinutes:30,commercialSnapshot:purchaseContract(plan,extra)});
  await assert.rejects(intent({}),error=>error?.code==='PLAN_CAPACITY_EXHAUSTED','a direct repurchase of a full plan is refused before money is taken');
  assert((await intent({kind:'subscription_extension',extensionSubscriptionId:current.id})).id,'the holder can still extend');
  assert.equal(Number((await planCapacity.usage(plan.id)).planUsed),1,'extending takes no new place');

  const queued=await insert(holder,plan,{snapshot:{kind:'direct_plan',checkoutMode:'payment',mediaLocation:'London',billingInterval:'month',durationDays:30}});
  assert.equal(String(queued.media_server_id),String(server.id),'a queued repurchase keeps the occupied server');
  assert.equal(Number((await planCapacity.usage(plan.id)).planUsed),1,'a queued purchase takes no place before it starts');
  assert.equal(await samePlanRepurchase.extensionTarget(holder.id,plan),null,'with a queued purchase no extension is offered');
  assert.deepStrictEqual((await samePlanRepurchase.assessHolding(holder.id,plan.id)).unprotectedIds,[]);
  const elsewhere=await insert(holder,plan,{snapshot:{kind:'direct_plan',checkoutMode:'payment',mediaLocation:'Elsewhere',billingInterval:'month',durationDays:30}});
  assert.equal(elsewhere.media_server_id,null,'a deliberately different location is not overridden');

  const emby=await makePlan('decide'),target=await makePlan('decide-target');
  const cases=[
    ['renewing',{recurring:true},false],['granted',{source:'admin_grant'},false],['handmade',{source:'manual'},false],
    ['imported',{source:'migration'},true],['credit',{source:'service_credit'},true],['ending',{recurring:true,cancelAtEnd:true},true],
    ['paid',{},true],['extension-only',{status:'cancelled',end:-1,ext:10},true]
  ];
  for(const [label,fixture,protects] of cases){
    const customer=await makeCustomer('decide-'+label);
    const row=await insert(customer,emby,{start:-5,end:20,...fixture});
    assert.deepStrictEqual(await samePlanRepurchase.assessHolding(customer.id,emby.id),{current:true,lifetime:false,unprotectedIds:protects?[]:[row.id]},label);
    const guard=samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:customer.id,planId:emby.id,kind:'direct_plan'});
    if(protects)await guard;
    else await assert.rejects(guard,error=>error?.code==='SAME_PLAN_PURCHASE_UNPROTECTED',label+': a direct purchase is refused');
    if(label==='renewing'){
      assert.deepStrictEqual(await samePlanRepurchase.extensionTarget(customer.id,emby),{subscriptionId:row.id});
      await query(`INSERT INTO customer_plan_changes(customer_id,current_subscription_id,target_plan_id,provider,mode,state,effective_at)
        VALUES($1,$2,$3,'stripe','period_end','pending',NOW()+INTERVAL '20 days')`,[customer.id,row.id,target.id]);
      assert.equal(await samePlanRepurchase.extensionTarget(customer.id,emby),null,'an open plan change blocks conversion');
    }
  }
  // The same rule inside checkout creation: refused with no intent left behind.
  const renewer=await makeCustomer('decide-intent'),jellyfin=await makePlan('decide-jf',{service:'jellyfin'});
  await insert(renewer,jellyfin,{recurring:true,start:-5,end:20});
  await assert.rejects(
    checkoutIntents.createIntent({scope:'customer',customerId:renewer.id,planId:jellyfin.id,provider:'stripe',checkoutMode:'payment',ttlMinutes:30,commercialSnapshot:purchaseContract(jellyfin)}),
    error=>error?.code==='SAME_PLAN_PURCHASE_UNPROTECTED','refused before any checkout exists');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM billing_checkout_intents WHERE customer_id=$1',[renewer.id])).rows[0].n,0);
  const unpaid=await makeCustomer('decide-unpaid');
  await insert(unpaid,emby,{recurring:true,status:'past_due',start:-5,end:20});
  assert.deepStrictEqual(await samePlanRepurchase.assessHolding(unpaid.id,emby.id),{current:false,lifetime:false,unprotectedIds:[]},'an unpaid renewal is not paid time');
  assert.deepStrictEqual(await samePlanRepurchase.assessHolding((await makeCustomer('decide-new')).id,emby.id),{current:false,lifetime:false,unprotectedIds:[]});
  // Lifetime holders are never charged, by an end date or by Permanent Access.
  for(const label of ['sentinel','permanent']){
    const customer=await makeCustomer('lifetime-'+label);
    const row=await insert(customer,emby,label==='sentinel'?{source:'migration',start:-5,end:new Date('9999-01-01T00:00:00Z')}:{source:'migration',status:'cancelled',start:-50,end:-5});
    if(label==='permanent')await query(`INSERT INTO customer_entitlement_overrides(customer_id,subscription_id,permanent_access,reason,previous_automation_protected) VALUES($1,$2,TRUE,'paid-time smoke',FALSE)`,[customer.id,row.id]);
    for(const kind of ['direct_plan','subscription_extension']){
      await assert.rejects(samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:customer.id,planId:emby.id,kind}),error=>error?.code==='SAME_PLAN_PURCHASE_LIFETIME',label+' '+kind);
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

  // An agreement known only by its provider identity is still recurring.
  const byIdentity=await makeCustomer('report-identity');
  await insert(byIdentity,plan,{source:'migration',start:-10,end:50});
  await insert(byIdentity,plan,{ref:`sub_paidtime_identity_${suffix}`,start:0,end:30});

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
  close(byIdentity,30,'recurring_over_nonrecurring');
  assert.equal(found(clean),undefined,'queued purchases are not a loss');
}

async function cleanup(){
  const remove=(sql,ids)=>query(sql,[ids]).catch(error=>console.warn('paid-time smoke cleanup incomplete:',error.message));
  for(const table of ['customer_entitlement_overrides','subscription_service_extension_events','payment_incidents','billing_checkout_intents','customer_plan_changes','jellyfin_server_placement_leases','subscription_access_extensions','subscriptions']){
    await remove(`DELETE FROM ${table} WHERE customer_id=ANY($1::uuid[])`,customerIds);
  }
  // Events recorded without a customer.
  await query('DELETE FROM payment_incidents WHERE customer_id IS NULL AND strpos(provider_event_id,$1)>0',[suffix]).catch(()=>{});
  await remove('DELETE FROM customers WHERE id=ANY($1::uuid[])',customerIds);
  await remove('DELETE FROM plan_server_eligibility WHERE plan_id=ANY($1::uuid[])',planIds);
  await query('UPDATE jellyfin_servers SET enabled=FALSE WHERE id=ANY($1::uuid[])',[serverIds]).catch(()=>{});
  await query('UPDATE plans SET active=FALSE,visible=FALSE WHERE id=ANY($1::uuid[])',[planIds]).catch(()=>{});
}

async function earlyTerminationQueue(){
  const plan=await makePlan('terminate-queue',{service:'jellyfin'});
  const other=await makePlan('terminate-independent',{service:'emby'});
  const customer=await makeCustomer('terminate-queue');
  const current=await insert(customer,plan,{start:-5,end:20,ext:10});
  const next=await insert(customer,plan),later=await insert(customer,plan);
  const independent=await insert(customer,other,{start:-5,end:40});
  const independentNext=await insert(customer,other);
  same(next.starts_at,current.access_end,'fixture queues behind full paid window');
  await termination.terminateLocal(current.id,customer.id);
  const ended=await get(current.id),first=await get(next.id),last=await get(later.id);
  same(first.starts_at,ended.current_period_end,'early termination immediately starts the next paid purchase');
  same(last.starts_at,first.access_end,'later paid purchase follows the newly active purchase');
  assert(Math.abs(duration(first)-duration(next))<2&&Math.abs(duration(last)-duration(later))<2,'termination preserves both purchased durations');
  same((await get(independentNext.id)).starts_at,independentNext.starts_at,'independent service queue remains unchanged');
  assert(ms(independent.current_period_end)>Date.now());
  await termination.terminateLocal(current.id,customer.id);
  same((await get(next.id)).starts_at,first.starts_at,'termination replay never moves the paid queue twice');
}

async function main(){
  try{
    await triggerOrder();
    await runtimePrivileges();
    assert.deepStrictEqual(await health.missingDatabaseFunctions(),[],'readiness finds every required function');
    await queueing();
    await upgrades();
    await activation();
    await extensionMovement();
    await refunds();
    await refundInsertLock();
    await lockOrder();
    await operatorEdits();
    await earlyTerminationQueue();
    await resumeRenewal();
    await convertedSettlement();
    await capacityPlacementAndDecisions();
    await report();
  }finally{await cleanup();}
  console.log('paid-time repurchase DB smoke: ok — queueing, activation replay and races, bought-time movement, refunds, capacity, placement and read-only report');
}

// Exit explicitly: operator actions reconcile access, which may keep handles open.
main().then(async()=>{await getPool().end();process.exit(0);}).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
