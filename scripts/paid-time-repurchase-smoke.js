'use strict';

// No-database checks for "a repurchase never costs paid time": server decisions,
// the browser plan cards, past-access Re-subscribe, queue movement call sites
// and a schema guard over the SQL that only PostgreSQL can fully execute.

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const ejs=require('ejs');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');

// The database module is replaced before anything requires it.
let queryHandler=async sql=>{throw new Error('Unexpected query: '+sql);};
let transactionClient=null;
const dbPath=require.resolve('../src/db');
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{
  query:(sql,params)=>queryHandler(sql,params),
  transaction:async work=>work(transactionClient),
  poolStats:()=>({max:1,total:0,idle:0,waiting:0,maxWaiting:1,saturated:false,overloaded:false}),
  getPool:()=>{throw new Error('No database in this smoke.');}
}};

const subscriptionState=require('../src/entitlements/subscription-state');
const providerPricing=require('../src/payments/provider-plan-pricing');
const samePlanRepurchase=require('../src/payments/same-plan-repurchase');
const extensions=require('../src/payments/subscription-access-extensions');
const prepaidRefunds=require('../src/payments/lifecycle-prepaid-refunds');
const checkout=require('../src/platform/flexible-checkout');
const compatibility=require('../src/db-compatibility-migrations');
const health=require('../src/platform/health');

const DAY=86400000;
const MIGRATION='20261127150000_paid_time_survives_repurchase.sql';
const plan={id:'plan-1',code:'monthly',name:'Monthly',service_type:'jellyfin',billing_interval:'month',duration_days:30,price_minor:600,currency:'GBP',streams:1};
const held=()=>({id:'plan-1',plan_id:'plan-1',subscription_id:'sub-1',customer_id:'cust-1',status:'active',source:'stripe',billing_mode:'payment',price_minor:600,billing_interval:'month',streams:1,service_extension_days:0,current_period_end:new Date(Date.now()+10*DAY),commercial_snapshot:{accessQuantity:1,accessVariantKind:'streams'}});
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));

async function currentHolderRules(){
  const original=subscriptionState.effectiveSubscription;
  try{
    let row=held();
    subscriptionState.effectiveSubscription=async()=>row;
    assert(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),'a one-off holder of this plan must be recognised');
    row={...held(),plan_id:'other'};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'a different plan is not a same-plan holder');
    row={...held(),current_period_end:new Date(Date.now()-DAY)};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'ended access cannot be extended');
    row={...held(),status:'expired',current_period_end:new Date(Date.now()-DAY),service_extension_days:5};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'mirrors the checkout rule for expired rows');
    row={...held(),is_free_tier:true};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'free access is never extended');

    row=held();
    let facts={has_queued:false,change_open:false};
    queryHandler=async()=>({rows:[facts],rowCount:1});
    assert.deepStrictEqual(await samePlanRepurchase.extensionTarget('cust-1',plan),{subscriptionId:'sub-1'});
    facts={has_queued:true,change_open:false};
    assert.equal(await samePlanRepurchase.extensionTarget('cust-1',plan),null,'no extension while purchases are queued');
    facts={has_queued:false,change_open:true};
    assert.equal(await samePlanRepurchase.extensionTarget('cust-1',plan),null,'no extension during a plan change');
    facts={has_queued:false,change_open:false};
    row={...held(),service_extension_days:3640};
    assert.equal(await samePlanRepurchase.extensionTarget('cust-1',plan),null,'no extension past the cap');
    row={...held(),blocked:true};
    assert.equal(await samePlanRepurchase.extensionTarget('cust-1',plan),null,'no extension on a held account');

    const rows=[{id:'migrated',renewing:false,queue_protected:true},{id:'renewing',renewing:true,queue_protected:true},{id:'granted',renewing:false,queue_protected:false}];
    const db=async sql=>{assert(sql.includes('public.prepaid_paid_time'),'the shared paid-time definition decides whether queueing protects');return{rows};};
    assert.deepStrictEqual(await samePlanRepurchase.assessHolding('cust-1','plan-1',{db}),{current:true,lifetime:false,unprotectedIds:['renewing','granted']},'a renewing agreement is never protected by queueing');
    const forever=async()=>({rows:[{id:'forever',renewing:false,queue_protected:false,lifetime:true}]});
    for(const kind of ['direct_plan','subscription_extension'])await assert.rejects(samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind},{db:forever}),{code:'SAME_PLAN_PURCHASE_LIFETIME'},'nothing is sold to a lifetime holder');
    row={...held(),current_period_end:new Date('9999-01-01')};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'no Extend for a lifetime end');
    row={...held(),access_expires_at:Infinity};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'no Extend for permanent access');
    row=held();
    await assert.rejects(samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind:'direct_plan'},{db}),{code:'SAME_PLAN_PURCHASE_UNPROTECTED'});
    await samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind:'subscription_extension'},{db});
    await samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind:'direct_plan'},{db:async()=>({rows:[rows[0]]})});
    await samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind:'direct_plan'},{db:async()=>({rows:[]})});
    await failedAssessmentRefusesOnlyHolders();
  }finally{subscriptionState.effectiveSubscription=original;}
}

// An assessment that errors refuses only a buyer with live paid time on the plan.
async function failedAssessmentRefusesOnlyHolders(){
  const warn=console.warn;
  let probe,statements;
  const db=async sql=>{
    statements.push(sql);
    if(sql.includes('public.prepaid_'))throw new Error('function public.prepaid_paid_time(uuid) does not exist');
    if(sql.includes('SAVEPOINT'))return{rows:[]};
    assert(sql.includes('customer_entitlement_overrides')&&!sql.includes('public.'),'the probe needs no database function');
    if(probe instanceof Error)throw probe;
    return{rows:probe};
  };
  const check=(kind,transactional=false)=>{statements=[];return samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind},{db,transactional});};
  const unverified={code:'SAME_PLAN_PURCHASE_UNVERIFIED'};
  try{
    console.warn=()=>{};
    probe=[];
    for(const kind of ['direct_plan','subscription_extension'])await check(kind);
    await check('direct_plan',true);
    assert.deepStrictEqual(statements.map(sql=>sql.includes('SAVEPOINT')?sql:sql.includes('public.prepaid_')?'assess':'probe'),
      ['SAVEPOINT paid_time_check','assess','ROLLBACK TO SAVEPOINT paid_time_check','probe'],'the transaction stays usable for the checkout');
    probe=[{lifetime:false}];
    await assert.rejects(check('direct_plan'),unverified,'a real holder is not charged unverified');
    await assert.rejects(check('direct_plan',true),unverified);
    await check('subscription_extension');
    probe=[{lifetime:true}];
    await assert.rejects(check('subscription_extension'),unverified);
    probe=new Error('connection lost');
    for(const kind of ['direct_plan','subscription_extension'])await assert.rejects(check(kind),unverified,'nothing is sold when nothing can be checked');
    const healthy=[];
    await samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind:'direct_plan'},{db:async sql=>{healthy.push(sql);return{rows:[]};},transactional:true});
    assert.equal(healthy.length,3);assert.equal(healthy[2],'RELEASE SAVEPOINT paid_time_check');
  }finally{console.warn=warn;}
}

async function repurchaseDecision(){
  const originalHolding=samePlanRepurchase.assessHolding,originalTarget=samePlanRepurchase.extensionTarget,originalOptions=providerPricing.getExtensionOptions,originalWarn=console.warn;
  const payment={...plan,checkout_mode:'payment',variant_kind:'streams',access_quantity:1,quantity:1};
  const recurring={...payment,checkout_mode:'subscription'};
  try{
    console.warn=()=>{};
    const unprotected={current:true,unprotectedIds:['sub-1']},queued={current:true,unprotectedIds:[]},none={current:false,unprotectedIds:[]};
    let holding=unprotected,target={subscriptionId:'sub-1'},subscription=held(),fullPlanLookups=0;
    samePlanRepurchase.assessHolding=async()=>holding;
    samePlanRepurchase.extensionTarget=async()=>target;
    providerPricing.getExtensionOptions=async()=>{fullPlanLookups++;return[payment];};
    queryHandler=async sql=>{
      if(sql.includes('FROM plans WHERE code'))return{rows:[plan],rowCount:1};
      if(sql.includes('public.subscription_access_blocked'))return{rows:[subscription],rowCount:1};
      throw new Error('Unexpected query: '+sql);
    };
    const request=(body={})=>({session:{customerId:'cust-1'},body});
    const decide=(options,requested='payment',body={})=>checkout.repurchaseAsExtension(request(body),'stripe','monthly',1,requested,options);
    const refused=(promise,message)=>assert.rejects(promise,{code:'SAME_PLAN_PURCHASE_UNPROTECTED'},message);

    assert.equal((await decide([payment])).subscriptionId,'sub-1','time that queueing cannot protect is extended');
    assert.equal((await decide([payment],null)).subscriptionId,'sub-1','a single one-off option counts as a one-off purchase');
    assert.equal(await decide([payment,recurring],null),null,'an unresolved payment-type choice is left to the choice page');
    assert.equal(await decide([recurring],'subscription'),null,'recurring checkouts are untouched');
    assert.equal((await decide([payment],'payment',{discountCode:'SAVE'})).subscriptionId,'sub-1','a discounted purchase must extend rather than overlap existing paid time');
    await refused(decide([payment],'payment',{applyServiceCredit:'on'}),'service credit cannot either');
    await refused(decide([recurring],'payment'),'no one-off price is invented for a plan that only sells renewals');
    target=null;await refused(decide([payment]),'queued rows, a plan change or a held account refuse instead of overlapping');
    await refused(decide([payment],'payment',{discountCode:'SAVE'}),'a promotion cannot bypass the paid-time protection when no extension is possible');
    target={subscriptionId:'another'};await refused(decide([payment]),'an extension of a different row does not protect the unprotected one');
    target={subscriptionId:'sub-1'};subscription={...held(),commercial_snapshot:{accessQuantity:3}};
    await refused(decide([payment]),'a different allowance is refused, not sold over paid time');
    subscription={...held(),blocked:true};await refused(decide([payment]));
    subscription=held();
    samePlanRepurchase.extensionTarget=async()=>{throw new Error('boom');};
    await refused(decide([payment]),'an unexpected conversion failure never falls through to a direct purchase');
    samePlanRepurchase.extensionTarget=async()=>target;
    samePlanRepurchase.assessHolding=async()=>{throw new Error('function does not exist');};
    await assert.rejects(decide([payment]),{code:'SAME_PLAN_PURCHASE_UNVERIFIED'},'an unverifiable holder is refused before money');
    const lookups=queryHandler;
    let probed=[{lifetime:false}];
    queryHandler=async(sql,params)=>sql.includes('customer_entitlement_overrides')?{rows:probed,rowCount:probed.length}:lookups(sql,params);
    await assert.rejects(decide([payment]),{code:'SAME_PLAN_PURCHASE_UNVERIFIED'},'a real holder is refused');
    probed=[];
    assert.equal(await decide([payment]),null,'a buyer with nothing to lose is not refused because the assessment failed');
    queryHandler=async()=>{throw new Error('database unavailable');};
    assert.equal(await decide([payment]),null,'a failed plan lookup is left to checkout creation');
    queryHandler=lookups;
    samePlanRepurchase.assessHolding=async()=>holding;

    // Protected holders and buyers without current time are never refused.
    for(const state of [queued,none]){
      holding=state;
      for(const body of [{},{discountCode:'SAVE'},{applyServiceCredit:'on'}])assert.equal(await decide([payment],'payment',body),null);
    }
    holding=queued;target=null;
    assert.equal(fullPlanLookups,0);
    assert.equal(await decide([]),null,'a full plan with no possible extension keeps the existing direct answer');
    assert.equal(await decide([],'payment',{discountCode:'SAVE'}),null);
    target={subscriptionId:'sub-1'};
    assert.equal((await decide([])).subscriptionId,'sub-1','the holder of a full plan can still add time');
    assert.equal((await decide([])).reason,'plan_full');fullPlanLookups=1;
    holding=unprotected;assert.equal((await decide([payment])).reason,'unprotected');holding=queued;
    assert.equal(checkout.commercialSnapshot({plan:payment,mode:'payment',extensionSubscriptionId:'sub-1',repurchaseReason:'plan_full'},'stripe').repurchaseReason,'plan_full');
    assert.equal(fullPlanLookups,1);
    holding={current:true,lifetime:true,unprotectedIds:[]};
    await assert.rejects(decide([payment]),{code:'SAME_PLAN_PURCHASE_LIFETIME'});
    assert.equal(await decide([recurring],'subscription'),null,'recurring checkouts are still untouched');
    for(const message of Object.values(samePlanRepurchase.MESSAGES))assert(checkout.CHECKOUT_SAFE.includes(message),'refusals must reach the customer');
    const {UNPROTECTED}=samePlanRepurchase.MESSAGES;
    assert(UNPROTECTED.includes('at your current allowance, use Extend')&&UNPROTECTED.includes('To change your allowance, contact support'),'a buyer of a different allowance is not sent to Extend');
    const intents=read('src/payments/checkout-intents.js');
    assert(intents.indexOf('assertPurchaseKeepsPaidTime')>intents.indexOf('await lockCheckoutOwner(client, customerId);')&&intents.indexOf('assertPurchaseKeepsPaidTime')<intents.indexOf('INSERT INTO billing_checkout_intents'),'every intent is checked under the customer lock');
    const zero=read('src/payments/zero-value-checkout.js');
    assert(zero.indexOf('assertPurchaseKeepsPaidTime')>0&&zero.indexOf('assertPurchaseKeepsPaidTime')<zero.indexOf('INSERT INTO subscriptions('),'zero-value settlement applies the same rule');
    const primitives=read('src/payments/lifecycle-primitives.js');
    assert(!primitives.includes('assertPurchaseKeepsPaidTime'),'nothing new may refuse a paid activation');
  }finally{samePlanRepurchase.assessHolding=originalHolding;samePlanRepurchase.extensionTarget=originalTarget;providerPricing.getExtensionOptions=originalOptions;console.warn=originalWarn;}
}

async function queueMovementCallSites(){
  const replayCalls=[];
  const prior={customer_id:'cust-1',subscription_id:'sub-1',plan_id:'plan-1',provider:'stripe',provider_payment_id:'pi_1'};
  const replay=await extensions.applyPurchase({query:async sql=>{
    replayCalls.push(sql);
    if(sql.includes('FROM subscription_access_extensions'))return{rows:[prior],rowCount:1};
    return{rows:[{id:'sub-1',service_extension_days:30}],rowCount:1};
  }},{customerId:'cust-1',subscriptionId:'sub-1',planId:'plan-1',provider:'stripe',providerPaymentId:'pi_1'});
  assert.equal(replay.replay,true);
  assert(!replayCalls.some(sql=>sql.includes('shift_prepaid_queue')),'a provider replay must not move queued time again');
  await operatorEditsMoveTheQueue();
  await resumeRenewalIsBlocked();
  await convertedSettlementFailures();
  await providerUpdatesLockTheCustomerFirst();

  const calls=[];
  const end=new Date(Date.now()+10*DAY);
  const extension={id:'ext-1',customer_id:'cust-1',subscription_id:'sub-1',status:'active',purchased_days:30,applied_days:30,commercial_snapshot:{billingInterval:'month',durationDays:30}};
  transactionClient={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('SELECT s.id,s.service_extension_days'))return{rows:[{id:'sub-1',service_extension_days:30}],rowCount:1};
    if(sql.includes("SET status='revoked'"))return{rows:[{...extension,status:'revoked'}],rowCount:1};
    if(sql.includes('SELECT * FROM subscriptions'))return{rows:[{id:'sub-1',service_extension_days:30,current_period_end:end}],rowCount:1};
    if(sql.includes('WHERE subscription_id=$1'))return{rows:[{...extension,status:'revoked'}],rowCount:1};
    if(sql.includes('WHERE provider=$1 AND provider_payment_id=$2'))return{rows:[extension],rowCount:1};
    return{rows:[{id:'sub-1',service_extension_days:0}],rowCount:1};
  }};
  await extensions.revokeByProviderPayment({provider:'stripe',providerPaymentId:'pi_1',customerId:'cust-1'});
  const position=text=>calls.findIndex(call=>call.sql.includes(text));
  assert(position('FOR UPDATE OF c')===0&&position('FOR UPDATE OF c')<position('FOR UPDATE OF s'),'customer row is locked first, as activation does');
  assert(!calls[0].sql.includes('starts_at'),'the customer lock does not depend on a racy look at the queue');
  const shift=calls[position('shift_prepaid_queue_after_end_change')];
  assert(shift,'revoking bought time must move the queue back');
  assert.deepStrictEqual(shift.params,['sub-1',30],'the move is measured from the days held before the revoke');
  assert(calls.indexOf(shift)>position('UPDATE subscriptions SET service_extension_days'),'the queue moves after the new access end is written');

  const source=read('src/payments/subscription-access-extensions.js');
  const applied=source.slice(source.indexOf('async function applyPurchase'),source.indexOf('async function extensionIdentity'));
  assert(applied.indexOf('shiftQueuedPurchases(client')>applied.indexOf('service_extension_days=COALESCE(service_extension_days,0)+$2'),'buying time must move the queue in the same transaction');

  const refundCalls=[];
  const originalEnd=new Date(Date.now()+20*DAY),cutoff=new Date(Date.now());
  transactionClient={query:async(sql,params)=>{
    refundCalls.push({sql,params});
    if(sql.includes('FOR UPDATE OF s'))return{rows:[{id:'sub-1',customer_id:'cust-1',status:'active',starts_at:new Date(Date.now()-10*DAY),current_period_end:originalEnd,service_extension_days:7,service_type:'jellyfin'}],rowCount:1};
    return{rows:[],rowCount:0};
  }};
  const result=await prepaidRefunds.applyPrepaidRefund({subscriptionId:'sub-1',customerId:'cust-1',originalEnd,cutoffAt:cutoff,serviceType:'jellyfin'});
  const pull=refundCalls.find(call=>call.sql.includes('public.pull_prepaid_queue'));
  assert(pull,'a pro-rata refund moves queued purchases through the shared owner');
  assert(/FROM customers WHERE id=\$1 FOR UPDATE/.test(refundCalls[0].sql),'a pro-rata refund locks the customer before the subscription');
  assert.deepStrictEqual(refundCalls[0].params,['cust-1']);
  const migrationSql=read(`db/migrations/${MIGRATION}`),reconciler=migrationSql.slice(migrationSql.indexOf('FUNCTION reconcile_future_prepaid_full_refund'));
  assert(reconciler.indexOf('PERFORM 1 FROM customers')>0&&reconciler.indexOf('PERFORM 1 FROM customers')<reconciler.indexOf('SELECT s.* INTO refunded'),'the refund trigger uses the same order');
  assert(result.removedMs>0);
  assert.equal(+new Date(pull.params[2]),+originalEnd,'queue reduction starts from the original base end');
  assert.equal(pull.params[3],7,'previous extension days are included in the original access end');
  assert.equal(pull.params[4],'sub-1','the surviving holder determines the new access end');
  assert.equal(pull.params[5],'sub-1','the refunded row never blocks its own queue');
  assert(pull.sql.includes('current_period_end+make_interval(days=>service_extension_days)'),'queue compaction subtracts the actual surviving access window');
}

// Every operator write to a paid end locks the customer first and then moves the
// queue before its transaction ends.
async function operatorEditsMoveTheQueue(){
  const queued=require('../src/payments/queued-purchases');
  const seen=[];
  const client={query:async(sql,params)=>{seen.push({sql,params});return{rows:sql.includes('::text AS period_end')?[{period_end:'2030-01-01 00:00:00.123456+00',service_extension_days:3}]:[]};}};
  await queued.lockQueueOwner(client,'cust-1');
  await queued.moveQueuedPurchases(client,'sub-1',await queued.accessEndBefore(client,'sub-1'));
  assert(/FROM customers WHERE id=\$1 FOR UPDATE/.test(seen[0].sql));
  assert.deepStrictEqual(seen[2].params,['sub-1',3,'2030-01-01 00:00:00.123456+00'],'the previous end keeps its microseconds');
  seen.length=0;await queued.moveQueuedPurchases(client,'sub-1',null);assert.equal(seen.length,0);
  const count=(file,pattern)=>(read(file).match(pattern)||[]).length;
  for(const [file,writes] of [
    ['src/access/admin-customer-individual-action-service.js',4],
    ['src/access/admin-customer-lifecycle-service.js',1],
    ['src/customers/bulk-operations.js',3],
    ['src/customers/operator-bulk-operations.js',1],
    ['src/payments/legacy-customer-import.js',1]
  ]){
    assert.equal(count(file,/queuedPurchases\.lockQueueOwner\(/g),writes,file+': customer lock before each edit');
    assert.equal(count(file,/queuedPurchases\.accessEndBefore\(/g),writes,file);
    assert.equal(count(file,/queuedPurchases\.moveQueuedPurchases\(/g),writes,file+': the queue moves with each edit');
  }
}

async function resumeRenewalIsBlocked(){
  const queued=require('../src/payments/queued-purchases'),billing=require('../src/payments/billing-control');
  let waiting=true,providerCalls=0;
  const writes=[];
  queryHandler=async sql=>{
    if(sql.includes('AS queued'))return{rows:[{queued:waiting}],rowCount:1};
    if(/^\s*(INSERT|UPDATE)/i.test(sql))writes.push(sql);
    return{rows:[{id:'sub-1',customer_id:'cust-1',source:'stripe',billing_mode:'subscription',provider_subscription_id:'sub_1',status:'active',cancel_at_period_end:true}],rowCount:1};
  };
  const adapter={resumeRenewal:async()=>{providerCalls++;},stopRenewal:async()=>{providerCalls++;},fetchRemote:async()=>{providerCalls++;return null;}};
  await assert.rejects(billing.setRenewal('sub-1',true,null,{adapter}),{message:queued.RESUME_BLOCKED});
  assert.equal(providerCalls,0,'the provider is never asked to resume');
  assert.deepStrictEqual(writes,[],'no provider operation is opened');
  assert(require('../src/platform/customer-subscription-actions').SUBSCRIPTION_ACTION_SAFE.includes(queued.RESUME_BLOCKED),'the customer sees why');
  const control=read('src/payments/billing-control.js'),recovery=control.slice(control.indexOf('async function recoverProviderOperation'));
  assert(recovery.indexOf('hasPurchaseQueuedBehind')>0&&recovery.indexOf('hasPurchaseQueuedBehind')<recovery.indexOf('remoteAdapter.resumeRenewal'),'recovery does not resume over a queued purchase either');
}

async function providerUpdatesLockTheCustomerFirst(){
  const primitives=require('../src/payments/lifecycle-primitives'),seen=[];
  transactionClient={query:async(sql,params)=>{seen.push({sql,params});return{rows:[],rowCount:0};}};
  assert.equal(await primitives.updateProviderSubscription({provider:'stripe',providerSubscriptionId:'sub_1',providerStatus:'active'}),null);
  assert(/^SELECT id FROM customers WHERE id IN \(SELECT customer_id FROM subscriptions .*ORDER BY id FOR UPDATE$/.test(seen[0].sql),'the customer is locked before the subscription');
  assert.deepStrictEqual(seen[0].params,['stripe','sub_1']);
  assert(seen[1].sql.startsWith('UPDATE subscriptions SET status'));
}

// What happens when a paid repurchase can no longer be applied as an extension.
async function convertedSettlementFailures(){
  const primitives=require('../src/payments/lifecycle-primitives'),capacity=require('../src/entitlements/plan-capacity');
  const originalApply=extensions.applyPurchase,originalHolding=samePlanRepurchase.assessHolding,originalCapacity=capacity.lockAndAssert;
  const originalError=console.error,originalWarn=console.warn;
  let statements=[],existing=[],holding={current:true,unprotectedIds:[]},applyError='ACCESS_EXTENSION_ALLOWANCE_CHANGED',applications=0,capacityChecks=0,full=false;
  try{
    console.error=()=>{};console.warn=()=>{};
    extensions.applyPurchase=async()=>{applications++;const error=new Error('cannot apply');error.code=applyError;throw error;};
    samePlanRepurchase.assessHolding=async()=>holding;
    capacity.lockAndAssert=async()=>{capacityChecks++;if(full){const error=new Error('full');error.code='PLAN_CAPACITY_EXHAUSTED';throw error;}};
    queryHandler=async(sql,params)=>{statements.push({sql,params});const rows=sql.includes('INSERT INTO payment_incidents')?[{id:'incident'}]:[];return{rows,rowCount:rows.length};};
    transactionClient={query:async(sql,params)=>{
      statements.push({sql,params});
      const one=row=>({rows:[row],rowCount:1});
      if(sql.includes('SELECT id FROM customers'))return one({id:'cust-1'});
      if(sql.includes('SELECT * FROM plans'))return one(plan);
      if(sql.startsWith('SELECT * FROM subscriptions WHERE source'))return{rows:existing,rowCount:existing.length};
      if(sql.includes('FROM billing_checkout_intents WHERE id'))return one({id:'intent-1',customer_id:'cust-1',plan_id:'plan-1',provider:'stripe',state:'open'});
      if(sql.includes('INSERT INTO subscriptions'))return one({id:'sub-new',customer_id:'cust-1',plan_id:'plan-1',status:'active',billing_mode:'payment'});
      return{rows:[],rowCount:0};
    }};
    const activate=reason=>{statements=[];return primitives.activatePurchase({customerId:'cust-1',planId:'plan-1',provider:'stripe',providerSubscriptionId:'pi_1',providerStatus:'active',
      commercialSnapshot:{kind:'subscription_extension',extensionSubscriptionId:'sub-1',repurchaseReason:reason,checkoutIntentId:'intent-1',planId:'plan-1',provider:'stripe',checkoutMode:'payment',priceMinor:600,durationDays:30,billingInterval:'month',currency:'GBP'}});};
    const inserted=()=>statements.find(row=>row.sql.includes('INSERT INTO subscriptions'));
    const incident=()=>statements.find(row=>row.sql.includes('INSERT INTO payment_incidents'));

    assert.equal((await activate('plan_full')).id,'sub-new','a full-plan repurchase still activates as a queued purchase');
    const rollback=statements.findIndex(row=>row.sql.startsWith('ROLLBACK TO SAVEPOINT'));
    assert(rollback>0&&rollback<statements.indexOf(inserted()));
    const stored=inserted().params.find(value=>typeof value==='string'&&value.includes('repurchaseFallback'));
    assert.equal(JSON.parse(stored).kind,'direct_plan');
    assert(statements.some(row=>row.sql.includes('UPDATE billing_checkout_intents SET commercial_snapshot')),'the intent no longer reads as an unfulfilled extension');
    assert.equal(capacityChecks,0,'the holder keeps their own place');

    existing=[{id:'sub-new',customer_id:'cust-1',plan_id:'plan-1',status:'active',billing_mode:'payment'}];applications=0;
    assert.equal((await activate('plan_full')).id,'sub-new');
    assert.equal(applications,0,'a replay finds the activated row');assert.equal(inserted(),undefined);
    existing=[];

    holding={current:true,unprotectedIds:['sub-1']};
    await assert.rejects(activate('plan_full'),{code:applyError});assert.equal(inserted(),undefined,'never over unprotected time');
    holding={current:false,unprotectedIds:[]};full=true;
    await assert.rejects(activate('plan_full'),{code:applyError});assert.equal(inserted(),undefined,'never into a full plan without a held place');
    full=false;holding={current:true,lifetime:true,unprotectedIds:[]};
    await assert.rejects(activate('plan_full'),{code:applyError});assert.equal(inserted(),undefined,'never beside access that became permanent');
    holding={current:true,unprotectedIds:[]};
    applyError='ACCESS_EXTENSION_PAYMENT_ALREADY_USED';
    await assert.rejects(activate('plan_full'),{code:applyError});assert.equal(inserted(),undefined,'payment identity conflicts never fall back');
    applyError='ACCESS_EXTENSION_TARGET_REPLACED';
    await assert.rejects(activate('unprotected'),error=>error.code===applyError&&error.paidButUnfulfilled===true);
    assert.equal(inserted(),undefined,'an unprotected repurchase is never activated over held time');
    const metadata=JSON.parse(incident().params[5]);
    assert.equal(metadata.reason,'unprotected_repurchase_extension_failed');
    assert.equal(metadata.extensionFailureCode,applyError);assert.equal(metadata.extensionSubscriptionId,'sub-1');assert(metadata.operatorAction);
  }finally{extensions.applyPurchase=originalApply;samePlanRepurchase.assessHolding=originalHolding;capacity.lockAndAssert=originalCapacity;console.error=originalError;console.warn=originalWarn;}
}

// A very small DOM: enough to run the two browser scripts.
function node(extra={}){
  return Object.assign({dataset:{},children:[],textContent:'',innerHTML:'',classList:{add(){},remove(){},toggle(){}},
    append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);},prepend(){},
    setAttribute(){},addEventListener(){},insertAdjacentElement(){},querySelector:()=>null,querySelectorAll:()=>[],closest:()=>null,remove(){}},extra);
}
function parseForms(html){
  return Array.from(String(html).matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)).map(match=>{
    const inputs={};
    for(const input of match[2].matchAll(/<input\b[^>]*>/g)){
      const name=/name="([^"]+)"/.exec(input[0])?.[1],value=/value="([^"]*)"/.exec(input[0])?.[1]||'';
      if(name)inputs[name]=value;
    }
    return{action:match[1],inputs,button:/<button\b[^>]*class="([^"]+)"[^>]*>([\s\S]*?)<\/button>/.exec(match[2])?.slice(1,3)||[]};
  });
}

async function clientCards(){
  const variantPlan={planId:'plan-1',code:'monthly',kind:'streams',preferredQuantity:1,currentPlan:true,currentQuantity:1,currentProvider:null,
    extension:{subscriptionId:'sub-1',quantity:1,durationLabel:'Monthly',providers:['stripe','paypal','plisio']},
    variants:[1,2].map(quantity=>({quantity,priceMinor:600*quantity,currency:'GBP',priceLabel:'price',soldOut:quantity===1,paymentOptions:[{provider:'stripe',checkoutMode:'payment'}]}))};

  async function run(planState){
    let appended=[];
    const actions=node();
    const forms=()=>parseForms(actions.innerHTML).map(form=>({
      getAttribute:()=>form.action,
      querySelector:selector=>{
        if(selector==='input[name="extensionSubscriptionId"]')return'extensionSubscriptionId' in form.inputs?{}:null;
        return null;
      },
      appendChild:input=>appended.push({form,input})
    }));
    const card=node({dataset:{planCode:'monthly'},querySelector:selector=>selector==='.planActions'?actions:selector==='.planDescription'?node():null,
      querySelectorAll:selector=>selector==='form'?forms():[]});
    let select=null,change=null;
    const document={
      querySelector:selector=>selector==='input[name="_csrf"]'?{value:'csrf'}:selector.startsWith('[data-plan-code=')?card:null,
      querySelectorAll:selector=>selector==='[data-plan-code]'?[card]:[],
      addEventListener(){},
      createElement(tag){
        if(tag==='input')return node();
        const element=node();
        element.querySelector=selector=>{
          if(selector!=='select')return null;
          select=node({value:/<option value="(\d+)" selected/.exec(element.innerHTML)?.[1],addEventListener:(_type,handler)=>{change=handler;}});
          return select;
        };
        return element;
      }
    };
    const fetch=async url=>({ok:!String(url).includes('readiness'),json:async()=>String(url).includes('plan-variants')?{plans:[planState]}:{media:false}});
    vm.runInNewContext(read('public/js/customer-checkout.js'),{document,fetch,CSS:{escape:String},window:{},Intl,setTimeout,clearTimeout,console});
    await settle();
    assert(select,'the variant picker must be installed');
    return{actions,appended:()=>appended,reset:()=>{appended=[];},choose:value=>{select.value=String(value);change();}};
  }

  const page=await run(variantPlan);
  let forms=parseForms(page.actions.innerHTML);
  assert(page.actions.innerHTML.includes('Current access allowance'));
  assert.deepStrictEqual(forms.map(form=>form.action),['/account/checkout/stripe','/account/checkout/paypal','/account/checkout/plisio'],'a one-off holder keeps every Extend button, even when the held allowance is full');
  assert(forms.every(form=>form.inputs.extensionSubscriptionId==='sub-1'&&form.inputs.checkoutMode==='payment'&&form.inputs.accessQuantity==='1'));

  // Equivalent to the server-rendered forms: same fields, labels and data attributes.
  const view=read('views/customer/dashboard.ejs');
  const end=new Date(Date.now()+10*DAY);
  const current={...plan,id:'sub-1',plan_id:'plan-1',subscription_id:'sub-1',status:'active',source:'stripe',current_period_end:end,commercial_snapshot:{streams:1}};
  const html=ejs.render(view,{siteName:'Test',currency:'GBP',portal:{customer:{login_username:'viewer'},subscriptions:[current],accounts:[],providers:[]},currentPlan:current,freePlan:null,stremioPlan:null,embyPlan:null,
    plans:[{...plan,payment_options:[{provider:'stripe'},{provider:'paypal'},{provider:'plisio'}]}],stripeEnabled:true,paypalEnabled:true,plisioEnabled:true,csrfToken:'csrf',message:null,error:null,openCheckout:null,openPlanChange:null,renewalSubscription:null,
    overseerrUrl:null,requestAccess:null,requestSyncConfigured:false,provisioningState:null,hasJellyfin:true,hasStremio:false,hasEmby:false,jellyfinAccounts:[],embyAccounts:[]},{filename:path.join(root,'views','customer','dashboard.ejs')});
  const server=parseForms(html).filter(form=>'extensionSubscriptionId' in form.inputs);
  assert.deepStrictEqual(forms,server,'browser-built Extend forms must match the server-rendered ones');
  assert(page.actions.innerHTML.includes('name="discountCode" data-promo-target'),'Extend forms submit the promo code');

  page.reset();
  page.choose(2);
  forms=parseForms(page.actions.innerHTML);
  assert(forms.some(form=>!('extensionSubscriptionId' in form.inputs)&&form.inputs.accessQuantity==='2'),'another allowance can still be bought');
  assert.equal(forms.filter(form=>form.inputs.extensionSubscriptionId==='sub-1').length,3,'choosing another allowance must not wipe Extend forms');
  assert(page.appended().length>0,'purchase forms still receive the server location');
  assert(page.appended().every(entry=>!('extensionSubscriptionId' in entry.form.inputs)),'Extend forms never pick a server location');

  const recurring=await run({...variantPlan,currentProvider:'stripe'});
  assert.equal(parseForms(recurring.actions.innerHTML).filter(form=>form.inputs.extensionSubscriptionId).length,3,'recurring payers who can extend keep Extend');

  // A holder whose time the purchase would wait behind can also buy separately,
  // Both purchase paths can carry an eligible promo code.
  const mixed=[{provider:'stripe',checkoutMode:'subscription'},{provider:'stripe',checkoutMode:'payment'},{provider:'paypal',checkoutMode:'subscription'},{provider:'plisio',checkoutMode:'payment'}];
  const offer=(changes={},variant={})=>({...variantPlan,separatePurchaseSafe:true,...changes,
    variants:[1,2].map(quantity=>({quantity,priceMinor:600*quantity,currency:'GBP',priceLabel:'price',soldOut:false,paymentOptions:mixed,...(quantity===1?variant:{})}))});
  const separate=view=>parseForms(view.actions.innerHTML).filter(form=>!('extensionSubscriptionId' in form.inputs));
  const extending=view=>parseForms(view.actions.innerHTML).filter(form=>form.inputs.extensionSubscriptionId);
  const safe=await run(offer());
  assert.deepStrictEqual(separate(safe).map(form=>form.action),['/account/checkout/stripe','/account/checkout/plisio'],'only providers with a one-off option');
  assert(separate(safe).every(form=>form.inputs.checkoutMode==='payment'&&form.inputs.accessQuantity==='1'&&'discountCode' in form.inputs&&'mediaLocation' in form.inputs),'one-off only, with the held allowance');
  const markup=safe.actions.innerHTML;
  assert.equal((markup.match(/<form class="plainForm checkoutForm" data-separate-purchase /g)||[]).length,2);
  assert.equal((markup.match(/data-promo-target/g)||[]).length,5,'separate and Extend forms receive the promo code');
  assert(markup.includes('Separate purchase: it starts after your current paid time ends. Eligible promo codes can apply to either purchase option.'));
  assert(markup.includes('Buy separately with Stripe')&&!markup.includes('Current access allowance'));
  assert.equal(extending(safe).length,3,'Extend stays beside it');
  assert.equal(safe.appended().length,2,'only the separate purchases pick a server location');

  for(const [label,planState] of [
    ['unprotected or lifetime',offer({separatePurchaseSafe:false})],
    ['unanswered',offer({separatePurchaseSafe:undefined})],
    ['recurring',offer({currentProvider:'stripe'})],
    ['no one-off option',offer({}, {paymentOptions:[{provider:'stripe',checkoutMode:'subscription'}]})]
  ]){
    const view=await run(planState);
    assert.deepStrictEqual(separate(view),[],label+': no direct purchase of the held allowance');
    assert(view.actions.innerHTML.includes('Current access allowance'),label);
    assert.equal(extending(view).length,3,label);
  }
  const full=await run(offer({},{soldOut:true}));
  assert.deepStrictEqual(separate(full),[],'a full allowance is not sold again');
  assert(full.actions.innerHTML.includes('Currently full for this allowance'));
  assert.equal(extending(full).length,3);
  safe.choose(2);
  assert(separate(safe).length&&separate(safe).every(form=>form.inputs.accessQuantity==='2'),'a different allowance keeps its ordinary forms');
  assert(!safe.actions.innerHTML.includes('data-separate-purchase')&&!safe.actions.innerHTML.includes('Separate purchase:'));
}

// The flag behind the separate purchase comes from the assessment checkout uses,
// and is never set beside a renewing agreement.
async function separatePurchaseFlag(){
  const warn=console.warn;
  const answer=rows=>({db:async sql=>{assert(sql.includes('public.prepaid_paid_time'));return{rows};}});
  const safe=rows=>samePlanRepurchase.separatePurchaseSafe('cust-1','plan-1',answer(rows));
  const kept={id:'kept',renewing:false,queue_protected:true,lifetime:false};
  const stubs=[];
  const stub=(module,name,value)=>{stubs.push([module,name,module[name]]);module[name]=value;};
  try{
    console.warn=()=>{};
    assert.equal(await safe([kept]),true);
    assert.equal(await safe([kept,{...kept,id:'granted',queue_protected:false}]),false,'any unprotected row');
    assert.equal(await safe([{...kept,renewing:true}]),false);
    assert.equal(await safe([kept,{...kept,id:'forever',lifetime:true}]),false,'lifetime access');
    assert.equal(await safe([]),false,'not a holder');
    assert.equal(await samePlanRepurchase.separatePurchaseSafe('cust-1','plan-1',{db:async()=>{throw new Error('unavailable');}}),false);

    const dashboard=require('../src/platform/customer-dashboard'),planPricing=require('../src/payments/plan-pricing'),planChange=require('../src/payments/customer-plan-change');
    const variants=[1,2].map(quantity=>({access_quantity:quantity,quantity,variant_kind:'streams',price_minor:600,currency:'GBP',capacity:{soldOut:false},payment_options:[{provider:'stripe',checkoutMode:'payment'}]}));
    const listed={...plan,access_variants:variants};
    stub(require('../src/customers'),'listPublicPlans',async()=>[listed]);
    stub(planPricing,'platformDefaultCurrency',async()=>'GBP');
    stub(planPricing,'decoratePlans',async plans=>plans);
    stub(require('../src/payments/stream-variants'),'decoratePlans',async plans=>plans);
    stub(require('../src/platform/product-readiness'),'context',async()=>({}));
    stub(require('../src/platform/product-readiness'),'evaluatePlan',async()=>({sellable:true}));
    stub(require('../src/payments/access-variant-capacity'),'decoratePlans',async plans=>plans);
    for(const provider of ['stripe','paypal','plisio'])stub(require('../src/payments/'+provider),'enabled',()=>true);
    let recurring=async()=>null,holder=held(),assessed=0,verdict=true;
    stub(planChange,'currentRecurring',(...args)=>recurring(...args));
    stub(samePlanRepurchase,'currentPaidSubscription',async()=>holder);
    stub(samePlanRepurchase,'separatePurchaseSafe',async(customerId,planId)=>{assessed++;assert.deepStrictEqual([customerId,planId],['cust-1','plan-1']);return verdict;});
    const state=async()=>(await dashboard.customerVariantState('cust-1'))[0];
    assert.equal((await state()).separatePurchaseSafe,true);
    verdict=false;assert.equal((await state()).separatePurchaseSafe,false);
    verdict=true;assessed=0;
    recurring=async()=>({plan_id:'plan-1',source:'stripe',billing_mode:'subscription',provider_subscription_id:'sub_1',cancel_at_period_end:true,commercial_snapshot:{streams:1}});
    const renewing=await state();
    assert.equal(renewing.currentProvider,'stripe');assert.equal(renewing.separatePurchaseSafe,false,'never beside a recurring agreement, even an ending one');
    recurring=async()=>{throw new Error('two overlapping agreements');};
    assert.equal((await state()).separatePurchaseSafe,false,'an unknown renewal state is not safe');
    recurring=async()=>null;holder=null;
    assert.equal((await state()).separatePurchaseSafe,false,'only a holder is assessed');
    assert.equal(assessed,0);
  }finally{console.warn=warn;for(const [module,name,value] of stubs.reverse())module[name]=value;}
}

async function pastAccessResubscribe(){
  async function run(sourceForms){
    let section=null;
    const clone=form=>node({action:form.action,extension:form.extension,querySelector:selector=>selector==='button'?node():null});
    const source=node({querySelectorAll:()=>sourceForms.map(form=>({
      querySelector:selector=>selector==='input[name="extensionSubscriptionId"]'&&form.extension?{}:null,
      hasAttribute:name=>name==='data-separate-purchase'&&Boolean(form.separate),
      cloneNode:()=>clone(form)
    }))});
    const anchor=node({insertAdjacentElement:(_where,element)=>{section=element;}});
    const document={head:node(),createElement:()=>node(),
      querySelector:selector=>selector==='.multiAccessSummary'?anchor:selector.startsWith('.planCard')?source:null,
      querySelectorAll:()=>[]};
    const fetch=async()=>({ok:true,json:async()=>({items:[{paid:true,planCode:'monthly'}]})});
    vm.runInNewContext(read('public/js/customer-home-access.js'),{document,fetch,location:{pathname:'/account'},window:{},Intl,Date,console});
    await settle();
    const found=[];
    (function walk(element){if(!element||typeof element!=='object')return;if(element.action||element.href)found.push(element);for(const child of element.children||[])walk(child);})(section);
    return found;
  }
  const extend={action:'/account/checkout/stripe',extension:true},buy={action:'/account/checkout/paypal',extension:false};
  assert.deepStrictEqual((await run([extend,buy])).map(item=>item.action),['/account/checkout/paypal'],'Re-subscribe never clones an Extend form');
  const again={action:'/account/checkout/plisio',separate:true};
  assert.deepStrictEqual((await run([extend,again,buy])).map(item=>item.action),['/account/checkout/paypal'],'nor a separate purchase offered beside current access');
  assert.equal((await run([again,extend]))[0].href,'/account?skipRestore=1#plans');
  const onlyExtend=await run([extend]);
  assert.equal(onlyExtend.length,1);
  assert.equal(onlyExtend[0].href,'/account?skipRestore=1#plans','with only Extend forms the card links to the plan instead');
}

// PostgreSQL is not available to fast checks, so at least prove that every
// column named through a table alias exists in the migration history.
function schemaGuard(){
  const directory=path.join(root,'db','migrations'),columns=new Map();
  const add=(table,column)=>{if(!columns.has(table))columns.set(table,new Set());columns.get(table).add(column.toLowerCase());};
  for(const file of fs.readdirSync(directory).filter(name=>name.endsWith('.sql'))){
    const sql=read('db/migrations/'+file).replace(/--.*$/gm,'');
    for(const match of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\);/gi)){
      for(const line of match[2].split('\n')){const name=/^\s*([a-z_][a-z0-9_]*)\s+\S/.exec(line)?.[1];if(name)add(match[1],name);}
    }
    for(const statement of sql.split(';')){
      const table=/ALTER TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?(\w+)/i.exec(statement)?.[1];
      if(!table)continue;
      for(const match of statement.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)/gi))add(table,match[1]);
    }
  }
  function check(file,aliases){
    const sql=read(file).replace(/--.*$/gm,'');
    let checked=0;
    for(const [alias,tables] of Object.entries(aliases)){
      for(const match of sql.matchAll(new RegExp(`(?<![\\w.])${alias}\\.([a-z_][a-z0-9_]*)`,'g'))){
        assert(tables.some(table=>columns.get(table)?.has(match[1])),`${file}: ${alias}.${match[1]} is not a column of ${tables.join('/')}`);
        checked++;
      }
    }
    assert(checked>10,`${file}: schema guard found too few references to be meaningful`);
  }
  assert(columns.get('subscriptions')?.has('billing_mode')&&columns.get('subscriptions')?.has('media_server_id'),'schema guard must understand later column additions');
  check(`db/migrations/${MIGRATION}`,{s:['subscriptions'],p:['plans'],held:['subscriptions'],held_plan:['plans'],bought:['plans'],anchor:['subscriptions'],refunded:['subscriptions'],host_server:['jellyfin_servers'],NEW:['subscriptions','payment_incidents']});
  check('docs/paid-time-overlap-report.sql',{s:['subscriptions'],p:['plans'],pi:['payment_incidents'],al:['audit_log'],c:['customers']});
}

const CASH_BASIS='20260829201000_provider_refund_cash_basis.sql';
function cashBasisFunction(sql){
  const found=sql.replace(/\r\n/g,'\n').match(/CREATE OR REPLACE FUNCTION (?:public\.)?enforce_provider_refund_cash_basis\(\)[\s\S]*?\n\$\$;/);
  assert(found,'cash-basis function not found');
  return found[0];
}
// A full-refund incident must hold the customer lock before its foreign key
// takes a key-share lock on the same row, or two of them deadlock.
function refundInsertLocksTheCustomerFirst(source){
  const migration=source.replace(/\r\n/g,'\n');
  const replaced=cashBasisFunction(migration),original=cashBasisFunction(read('db/migrations/'+CASH_BASIS));
  const lock=replaced.match(/ {4}-- lock-before-insert begin\n([\s\S]*?) {4}-- lock-before-insert end\n\n/);
  assert(lock,'lock block not found');
  assert.equal(replaced.replace(lock[0],'').replace('FUNCTION enforce_','FUNCTION public.enforce_'),original,'the cash-basis rules must stay exactly as they were');
  assert(replaced.indexOf(lock[0])<replaced.indexOf('NEW.amount_minor IS NULL'),'the lock comes before every early return');
  assert(/TG_OP='INSERT' AND NEW\.incident_type='refund'/.test(lock[1])&&/ORDER BY id\s+FOR UPDATE;/.test(lock[1]));
  for(const part of ["~* '^sub_'","~* '^I-'",'SELECT NEW.customer_id','s.provider_subscription_id=NEW.provider_subscription_id'])assert(lock[1].includes(part),part);
  const customerLocks=migration.match(/FROM (?:public\.)?customers\b[^;]*?FOR [A-Z ]*(?:UPDATE|SHARE);/g)||[];
  assert.equal(customerLocks.length,4);
  assert(customerLocks.every(text=>/(?<!KEY )FOR UPDATE;$/.test(text)),'a weaker customer lock is upgraded by the activation trigger');
  // The repeatable migration is skipped once applied, so a later definition of
  // this function would silently drop the lock.
  const definers=fs.readdirSync(path.join(__dirname,'..','db','migrations')).sort()
    .filter(file=>/FUNCTION\s+(?:public\.)?enforce_provider_refund_cash_basis\s*\(\)\s*RETURNS/i.test(read('db/migrations/'+file)));
  // The carried-time migration redefines it with the lock widened, which its
  // own smoke checks.
  assert.deepStrictEqual(definers,[CASH_BASIS,MIGRATION,'20261128120000_carried_paid_time_on_auto_renewal.sql']);
}

function contracts(){
  const migration=read(`db/migrations/${MIGRATION}`),report=read('docs/paid-time-overlap-report.sql');
  refundInsertLocksTheCustomerFirst(migration);
  assert(compatibility.isRepeatableCompatibilityMigration(MIGRATION),'the migration must stay rolling-compatible');
  assert(/^BEGIN;$/m.test(migration)&&/^COMMIT;$/m.test(migration));
  const statementsOnly=migration.replace(/--.*$/gm,'');
  assert(!/\b(ALTER|DROP|CREATE)\s+(TABLE|TRIGGER|INDEX)\b/i.test(statementsOnly),'no table or trigger DDL: it would lock live tables');
  assert(!/\bDROP FUNCTION\b/i.test(statementsOnly),'functions only, safe to re-run');
  const timeout=migration.indexOf("SET LOCAL lock_timeout = '5s';");
  assert(timeout>0&&timeout<migration.indexOf('CREATE OR REPLACE FUNCTION'),'a blocked migration must give up before touching anything');
  // The triggers that call the replaced functions come from the older, immutable
  // migrations that every fresh install applies first.
  for(const [file,trigger,call] of [
    ['20260829202000_prepaid_access_stacking.sql','trg_stack_prepaid_subscription_window','BEFORE INSERT ON subscriptions\nFOR EACH ROW\nEXECUTE FUNCTION stack_prepaid_subscription_window();'],
    ['20260829212000_prepaid_refund_reconciliation.sql','trg_reconcile_future_prepaid_full_refund','AFTER INSERT ON payment_incidents\nFOR EACH ROW\nEXECUTE FUNCTION reconcile_future_prepaid_full_refund();'],
    [CASH_BASIS,'payment_incidents_provider_refund_cash_basis','BEFORE INSERT OR UPDATE OF amount_minor, metadata, incident_type\nON payment_incidents\nFOR EACH ROW\nEXECUTE FUNCTION public.enforce_provider_refund_cash_basis();']
  ])assert(read('db/migrations/'+file).includes('CREATE TRIGGER '+trigger+'\n'+call),trigger+' must still be installed by '+file);
  assert(migration.includes('pg_advisory_xact_lock(hashtextextended(NEW.customer_id::text,0))'),'stacking keeps the same serialization lock');
  // The only refusals are the refund cash-basis ones, copied unchanged.
  assert(!/RAISE\s+EXCEPTION/i.test(migration.replace(cashBasisFunction(migration),'')),'nothing here may start refusing a paid activation');
  assert(migration.includes("'fully_discounted_local'"));
  // Stacking, pulling and pushing share one anchor definition.
  assert.equal((migration.match(/FROM public\.prepaid_stack_anchors\(/g)||[]).length,3);
  // Every public function the migration creates is granted to the runtime roles
  // and listed as required; trigger functions need no EXECUTE grant.
  const names=signatures=>signatures.map(signature=>signature.slice('public.'.length,signature.indexOf('('))).sort();
  // The required list is this migration's functions followed by those of later
  // repeatable migrations, which their own smoke compares with their grants.
  const created=Array.from(migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g),match=>match[1]).sort();
  const own=Array.from(compatibility.REQUIRED_FUNCTIONS).slice(0,created.length);
  assert.deepStrictEqual(names(own),created);
  const grants=migration.slice(migration.indexOf('DO $grants$'),migration.indexOf('$grants$;'));
  assert.deepStrictEqual(Array.from(grants.matchAll(/'(public\.[^']+)'/g),match=>match[1]),own,'grant list and required list must match');
  for(const role of ['steamfusion_app','steamfusion_automation'])assert(grants.includes("'"+role+"'"));
  const statements=report.replace(/--.*$/gm,'');
  assert(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i.test(statements),'the report must stay read only');
  assert.equal((statements.match(/;/g)||[]).length,1,'the report is a single statement');
  assert(!statements.includes('public.prepaid_'),'the report runs without the new functions');
  const rule=sql=>["(s.source IN ('stripe','paypal') AND s.billing_mode='subscription')","~* '^sub_'","~* '^I-'"].every(part=>sql.includes(part));
  assert(rule(report),'the report uses the same recurring rule as the database function');
  assert(migration.includes("(p_source IN ('stripe','paypal') AND p_billing_mode='subscription')")&&migration.includes("~* '^sub_'"));
}

async function readinessNeedsTheFunctions(){
  let missing=[{name:'public.prepaid_paid_time(uuid)'}];
  queryHandler=async(sql,params)=>{
    if(sql.includes('has_function_privilege')){assert.deepStrictEqual(params[0],Array.from(compatibility.REQUIRED_FUNCTIONS));return{rows:missing,rowCount:missing.length};}
    if(sql.includes('FROM schema_migrations'))return{rows:[{filename:health.latestMigration()}],rowCount:1};
    return{rows:[],rowCount:0};
  };
  let result=await health.readinessChecks();
  assert.equal(result.checks.migrations,true,'repeatable migrations stay outside the versioned ledger');
  assert.equal(result.checks.billingFunctions,false);
  assert.equal(result.ok,false,'a build whose database functions are missing must not take traffic');
  missing=[];result=await health.readinessChecks();
  assert.equal(result.checks.billingFunctions,true);
  assert.equal(health.publicResult(result).checks.billingFunctions,true);
}

(async()=>{
  contracts();
  await readinessNeedsTheFunctions();
  schemaGuard();
  await currentHolderRules();
  await repurchaseDecision();
  await queueMovementCallSites();
  await clientCards();
  await separatePurchaseFlag();
  await pastAccessResubscribe();
  console.log('paid-time repurchase smoke: ok');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
