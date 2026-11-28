'use strict';

// No-database checks for "a payment always adds time": refusals before money,
// the activation hand-off, the unpaid-cancellation end, and a guard over the
// selection, rounding, limit and lock SQL that only PostgreSQL can execute.
const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');

// The database module is replaced before anything requires it.
let queryHandler=async sql=>{throw new Error('Unexpected query: '+sql);};
const dbPath=require.resolve('../src/db');
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{
  query:(sql,params)=>queryHandler(sql,params),
  transaction:async work=>work({query:(sql,params)=>queryHandler(sql,params)}),
  getPool:()=>{throw new Error('No database in this smoke.');}
}};
const carriedTime=require('../src/payments/carried-time');
const compatibility=require('../src/db-compatibility-migrations');

const MIGRATION='20261128120000_carried_paid_time_on_auto_renewal.sql';
const PREVIOUS='20261127150000_paid_time_survives_repurchase.sql';
const recurring={id:'target',customer_id:'cust',source:'stripe',billing_mode:'subscription',status:'active',provider_subscription_id:'sub_1'};

async function beforeMoney(){
  const check=()=>carriedTime.assertCarryPossible({customerId:'cust',planId:'plan',snapshot:{streams:1}});
  for(const [row,code] of [
    [{lifetime:false,total_days:'0'},null],[{lifetime:false,total_days:'3650'},null],
    [{lifetime:false,total_days:'3651'},'CARRIED_TIME_LIMIT'],[{lifetime:true,total_days:'0'},'CARRIED_TIME_LIFETIME'],
    [{lifetime:false,total_days:'0',requires_value_transfer:true},'CARRIED_TIME_VALUE_TRANSFER_REQUIRED']
  ]){
    queryHandler=async(sql,params)=>{assert(sql.includes('public.carried_time_precheck'));assert(sql.includes('public.prepaid_paid_time')&&sql.includes('public.carryable_paid_time')&&sql.includes('public.prepaid_lanes_overlap'));assert.deepStrictEqual(params,['cust','plan','{"streams":1}']);return{rows:[row],rowCount:1};};
    if(code)await assert.rejects(check(),error=>error.code===code&&/not been charged/.test(error.message));
    else await check();
  }
  const warn=console.warn;console.warn=()=>{};
  queryHandler=async()=>{throw new Error('database away');};
  try{await assert.rejects(check(),{code:'CARRIED_TIME_UNVERIFIED'},'nothing is sold when the time cannot be checked');}
  finally{console.warn=warn;}
}

function client(answer){
  const seen=[];
  return{seen,query:async(sql,params)=>{seen.push(sql);const rows=await answer(sql,params)||[];return{rows,rowCount:rows.length};}};
}

async function activation(){
  for(const row of [{...recurring,status:'past_due'},{...recurring,status:'trialing'},{...recurring,billing_mode:'payment'},{...recurring,source:'plisio'}]){
    const db=client(()=>{throw new Error('nothing is asked for an unconfirmed or one-off purchase');});
    assert.deepStrictEqual(await carriedTime.carryOnActivation(db,row),{row,problem:null});
    assert.equal(db.seen.length,0);
  }
  const db=client(sql=>{
    if(sql.includes('carry_all_paid_time'))return[{result:{days:234,skipped:[]}}];
    if(sql.startsWith('SELECT * FROM subscriptions'))return[{...recurring,service_extension_days:234}];
  });
  const carried=await carriedTime.carryOnActivation(db,recurring);
  assert.equal(carried.row.service_extension_days,234);
  assert.equal(carried.problem,null);
  assert.equal(db.seen[0],'SAVEPOINT carried_time');

  const failing=client(sql=>{if(sql.includes('carry_all_paid_time'))throw Object.assign(new Error('boom'),{code:'23514'});});
  const failed=await carriedTime.carryOnActivation(failing,recurring);
  assert.equal(failed.row,recurring,'a paid activation never fails because of the carry');
  assert.equal(failed.problem.reason,'carried_time_failed');
  assert(failing.seen.includes('ROLLBACK TO SAVEPOINT carried_time'));
  for(const code of ['40001','40P01','55P03']){
    const conflict=client(sql=>{if(sql.includes('carry_all_paid_time'))throw Object.assign(new Error('retry'),{code});});
    await assert.rejects(carriedTime.carryOnActivation(conflict,recurring),{code},'a lock conflict retries the whole activation');
  }
  assert.equal(carriedTime.carryProblem({skipped:[{reason:'not_carried',subscriptionId:'a'}]}),null);
  assert.equal(carriedTime.carryProblem({skipped:[{reason:'over_limit',subscriptionId:'a'}]}).reason,'carried_time_over_limit');
  assert.equal(carriedTime.carryProblem({ineligible:'receiving_period_ended'}).reason,'carried_time_receiving_period_ended');
  const covered=client(sql=>{
    if(sql.includes('carry_all_paid_time'))return[{result:{days:0,carried:[{subscriptionId:'a',days:0}],skipped:[]}}];
    if(sql.startsWith('SELECT * FROM subscriptions'))return[{...recurring,media_server_id:'server'}];
  });
  assert.equal((await carriedTime.carryOnActivation(covered,recurring)).row.media_server_id,'server','a fully covered source still hands over');
  await firstPayment();
  assert.equal(carriedTime.owedProblem('returned'),null);
  assert.equal(carriedTime.owedProblem('owed').reason,'carried_time_owed_after_renewal_loss');

  const writes=[];
  queryHandler=async(sql,params)=>{writes.push({sql,params});return{rows:[],rowCount:1};};
  await carriedTime.recordOperatorIncident({customerId:'cust',subscription:recurring,reason:'carried_time_failed'});
  assert(writes[0].sql.includes("'checkout_completion','open'")&&writes[0].sql.includes("'preserve'")&&writes[0].sql.includes('DO NOTHING'));
  assert.equal(writes[0].params[1],'carried_time_failed:target');
}

async function firstPayment(){
  const quiet=client(()=>{throw new Error('nothing to look up');});
  assert.equal(await carriedTime.firstPaymentPending(quiet,null),false);
  assert.equal(await carriedTime.firstPaymentPending(quiet,{...recurring,status:'active'}),false,'an active row has been paid');
  assert.equal(await carriedTime.firstPaymentPending(quiet,{...recurring,status:'trialing'}),true);
  for(const status of ['past_due','paused'])for(const marked of [true,false]){
    const db=client(sql=>{assert(sql.includes('FROM audit_log')&&sql.includes('NOT EXISTS'));return marked?[{}]:[];});
    assert.equal(await carriedTime.firstPaymentPending(db,{...recurring,status}),marked,'only an unconfirmed first payment carries on recovery');
  }
  const none=client(()=>{throw new Error('an active or one-off row is not marked');});
  assert.equal(await carriedTime.markAwaitingFirstPayment(none,recurring),false);
  assert.equal(await carriedTime.markAwaitingFirstPayment(none,{...recurring,status:'past_due',billing_mode:'payment'}),false);
  const marks=client(()=>[]);
  assert.equal(await carriedTime.markAwaitingFirstPayment(marks,{...recurring,status:'past_due'}),true);
  assert(marks.seen[0].startsWith('INSERT INTO audit_log'));
}

async function unpaidEnd(){
  // Day 0 is when the renewal failed; the plan is yearly.
  const day=offset=>new Date(Date.UTC(2027,0,1)+offset*86400000);
  const run=async({priorStatus,priorEnd,incoming,status='cancelled',carried=true,hold=day(0),failed=false})=>{
    const db=client((sql,params)=>{
      if(sql.includes('FROM customer_access_holds')){assert.deepStrictEqual(params,['cust','stripe:sub_1','stripe','sub_1']);return hold?[{created_at:hold,failed_payment:failed}]:[];}
      if(sql.includes('subscription_time_carryovers'))return carried?[{}]:[];
    });
    return carriedTime.paidEndWhenAgreementEnds(db,{prior:{id:'target',customer_id:'cust',status:priorStatus,current_period_end:priorEnd,billing_interval_snapshot:'year'},status,periodEnd:incoming,provider:'stripe',providerSubscriptionId:'sub_1'});
  };
  const check=async(input,expected,message)=>assert.deepStrictEqual(await run(input),expected,message);
  await check({priorStatus:'past_due',priorEnd:day(365),incoming:day(365)},day(0),'an unpaid period is not paid time');
  await check({priorStatus:'past_due',priorEnd:day(-1),incoming:day(364)},day(-1),'an end the provider only now moves is unpaid too');
  await check({priorStatus:'past_due',priorEnd:day(-1),incoming:null},null,'an unmoved end is left as stored');
  await check({priorStatus:'paused',priorEnd:day(365),incoming:day(365),failed:true},day(0),'past due, then suspended, then cancelled');
  await check({priorStatus:'active',priorEnd:day(365),incoming:day(365),failed:true},day(0),'whatever the status before it ended');
  await check({priorStatus:'trialing',priorEnd:day(365),incoming:day(365),failed:true},day(0));
  await check({priorStatus:'cancelled',priorEnd:day(0),incoming:day(365),hold:null},day(0),'a later delivery cannot restore it');
  // A paid period is never shortened.
  await check({priorStatus:'paused',priorEnd:day(100),incoming:day(100)},day(100),'suspended part way through a paid period');
  await check({priorStatus:'past_due',priorEnd:day(100),incoming:day(100)},day(100),'a charge that failed part way through a paid period');
  await check({priorStatus:'paused',priorEnd:day(365),incoming:day(365)},day(365),'no failed payment');
  await check({priorStatus:'past_due',priorEnd:day(5),incoming:day(5)},day(5),'an end moved only to a retry date is left');
  await check({priorStatus:'active',priorEnd:day(30),incoming:day(30),hold:null},day(30),'an ordinary end is untouched');
  await check({priorStatus:'past_due',priorEnd:day(365),incoming:day(365),carried:false},day(365),'rows without carried time are untouched');
  await check({priorStatus:'past_due',priorEnd:day(365),incoming:day(365),status:'active'},day(365));
  await check({priorStatus:'past_due',priorEnd:day(365),incoming:day(365),status:'paused'},day(365));
  await check({priorStatus:'past_due',priorEnd:day(365),incoming:day(365),hold:null},day(365));
}

// PayPal does not report a cancellation while the recorded end is still ahead
// for an unpaid or suspended agreement: the hold stays open and the database
// rule protects the carried days. The end is clamped only once it is reported.
function payPalCancellationStaysOpen(){
  const paypal=require('../src/payments/paypal');
  for(const [status,expected] of [['past_due',null],['paused','SUSPENDED']]){
    const update=paypal.paidThroughCancellationUpdate({status,billing_mode:'subscription',current_period_end:new Date(Date.now()+86400000),refund_terminated_at:null},{status:'CANCELLED'});
    assert.equal(update.providerStatus,expected,status);
    assert.equal(update.preserved,true);
  }
}

function body(sql,name){
  const start=sql.search(new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${name}\\(`));
  assert(start>=0,name+' must be defined');
  return sql.slice(start,sql.indexOf('\n$$;',start));
}

function contracts(){
  const sql=read(`db/migrations/${MIGRATION}`),statements=sql.replace(/--.*$/gm,'');
  assert(compatibility.isRepeatableCompatibilityMigration(MIGRATION),'the migration must stay rolling-compatible');
  assert(/^BEGIN;$/m.test(sql)&&/^COMMIT;$/m.test(sql));
  const timeout=sql.indexOf("SET LOCAL lock_timeout = '5s';");
  assert(timeout>0&&timeout<sql.indexOf('CREATE TABLE'));
  assert(!/\b(ALTER|DROP)\s+(TABLE|TRIGGER|INDEX|FUNCTION)\b|\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i.test(statements),'additive only');
  assert.equal((statements.match(/CREATE TABLE/g)||[]).length,1);
  assert(statements.includes('CREATE TABLE IF NOT EXISTS public.subscription_time_carryovers'));
  assert(!/RAISE\s+EXCEPTION/i.test(statements.replace(body(statements,'enforce_provider_refund_cash_basis'),'')),'nothing here may refuse a paid activation');

  const created=Array.from(statements.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g),match=>match[1]);
  const grants=sql.slice(sql.indexOf('DO $grants$'),sql.indexOf('$grants$;'));
  const granted=Array.from(grants.matchAll(/'(public\.\w+\([^']*\))'/g),match=>match[1]);
  assert.deepStrictEqual(granted.map(name=>name.slice(7,name.indexOf('('))).sort(),[...created].sort());
  assert.deepStrictEqual(Array.from(compatibility.REQUIRED_FUNCTIONS).slice(compatibility.REQUIRED_FUNCTIONS.indexOf(granted[0]),compatibility.REQUIRED_FUNCTIONS.indexOf(granted[0])+granted.length),granted,'grant list and required list must match');
  assert(grants.includes('GRANT SELECT,INSERT,UPDATE ON TABLE public.subscription_time_carryovers'),'without table access every carry fails after payment');

  // Ledger: room for value conversion above 1, one live carry per source.
  assert(statements.includes('value_ratio numeric NOT NULL DEFAULT 1 CHECK (value_ratio>0)'));
  assert(/UNIQUE INDEX subscription_time_carryovers_active_source[\s\S]{0,120}WHERE status='active'/.test(statements));

  // Selection.
  const selection=body(statements,'carryable_paid_time');
  for(const rule of [
    "s.source IN ('stripe','paypal','plisio','migration','service_credit','manual','admin_grant')",
    's.superseded_by IS NULL','s.refund_terminated_at IS NULL','p.is_free_tier','p.is_addon',"<>'trial'","s.status<>'trialing'",
    "s.cancel_at_period_end AND s.status IN ('cancelled','expired')",'IS NOT DISTINCT FROM p_streams','IS NOT DISTINCT FROM p_households',
    'IS NOT DISTINCT FROM p_server_class',"INTERVAL '20 years'","pi.incident_status='lost'"
  ])assert(selection.includes(rule),'selection rule missing: '+rule);

  // One union for the precheck, the limit and the ledger, rounded up once.
  const ordered=/MAX\(\w+\.window_end\) OVER \(ORDER BY [^)]*ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING\)/;
  for(const name of ['carried_time_precheck','carried_time_total_days','rebalance_carried_time'])assert(ordered.test(body(statements,name)),name+' counts overlapping time once');
  assert(body(statements,'carried_time_precheck').includes('CEIL(COALESCE(SUM(uncovered.seconds),0)/86400)'));
  assert(body(statements,'carried_time_total_days').includes('CEIL(COALESCE(SUM(uncovered.seconds*uncovered.ratio),0)/86400)'));
  assert(body(statements,'rebalance_carried_time').includes('CEIL(valued.running/86400)-CEIL((valued.running-valued.own_value)/86400)'));
  for(const name of ['reverse_carried_paid_time','reduce_carried_paid_time','apply_carried_change'])assert(body(statements,name).includes('public.rebalance_carried_time('),name+' recounts the union');
  const carry=body(statements,'carry_paid_time');
  assert(carry.includes('>3650')&&carry.includes('RETURN -1'));
  assert(carry.indexOf('FROM customers')<carry.indexOf('pg_advisory_xact_lock')&&carry.indexOf('pg_advisory_xact_lock')<carry.indexOf('FROM subscriptions WHERE id=p_target FOR UPDATE'));
  assert(body(statements,'carry_all_paid_time').includes("'already',TRUE"));

  // Refund lock and reversal, including a web process without this change.
  const earlier=read(`db/migrations/${PREVIOUS}`).replace(/--.*$/gm,'');
  const afterLock=text=>{const guard=body(text,'enforce_provider_refund_cash_basis');return guard.slice(guard.indexOf("IF NEW.incident_type <> 'refund'")).replace(/\s+/g,' ');};
  assert.equal(afterLock(statements),afterLock(earlier),'the cash-basis refusals are unchanged');
  const lock=body(statements,'enforce_provider_refund_cash_basis');
  assert(lock.includes("NEW.incident_type='chargeback'")&&lock.includes('IF money_lost THEN')&&lock.includes('FOR UPDATE'),'every money loss locks the customer');
  assert(!lock.includes('subscription_time_carryovers'),'the lock never depends on an unlocked ledger read');
  const reconcile=body(statements,'reconcile_future_prepaid_full_refund');
  assert(reconcile.indexOf('reverse_carried_paid_time_by_payment')<reconcile.indexOf("IF NEW.incident_type <> 'refund'"),'reversal runs before the older early returns');
  const previousReconcile=body(earlier,'reconcile_future_prepaid_full_refund');
  const rest=text=>text.slice(text.indexOf("IF NEW.incident_type <> 'refund'")).replace(/\s+/g,' ');
  assert.equal(rest(reconcile),rest(previousReconcile),'the queued refund handling is unchanged');

  // Past due: inlined shape kept, exception only for rows holding extra days.
  const blocked=body(statements,'subscription_access_blocked');
  assert(!blocked.includes('SET search_path'));
  assert(blocked.includes('s.service_extension_days>0')&&blocked.includes('LEAST(h.created_at,s.current_period_end)'));

  // Nothing about the one-live-agreement rules changes.
  assert(!statements.includes('enforce_single_live_recurring_service'));

  const refunds=read('src/payments/operator-refund.js');
  assert(refunds.indexOf('if (sub.already_reversed) throw alreadyReversed();')>0&&refunds.indexOf('if (sub.already_reversed) throw alreadyReversed();')<refunds.indexOf('await assertCap(null);'),'reversed money cannot be refunded again');
  assert(read('src/entitlements/access-holds.js').includes("customer_access_holds.metadata->>'unpaid'='true'"),'a suspension keeps the failed payment on record');
  const primitives=read('src/payments/lifecycle-primitives.js');
  assert(primitives.indexOf('carriedTime.carryOnActivation(client, row)')<primitives.indexOf('syncProviderAccessState({ customerId: row.customer_id'));
  const intents=read('src/payments/checkout-intents.js');
  assert(intents.indexOf('lockCheckoutOwner(client, customerId)')<intents.indexOf('carriedTime.assertCarryPossible')&&intents.indexOf('carriedTime.assertCarryPossible')<intents.indexOf('INSERT INTO billing_checkout_intents'),'refused before a checkout exists');
}

(async()=>{
  contracts();
  payPalCancellationStaysOpen();
  await beforeMoney();
  await activation();
  await unpaidEnd();
  console.log('carried-time renewal smoke: ok');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
