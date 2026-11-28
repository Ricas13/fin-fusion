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
    [{lifetime:false,total_days:'3651'},'CARRIED_TIME_LIMIT'],[{lifetime:true,total_days:'0'},'CARRIED_TIME_LIFETIME']
  ]){
    queryHandler=async(sql,params)=>{assert(sql.includes('public.carried_time_precheck'));assert.deepStrictEqual(params,['cust','plan','{"streams":1}']);return{rows:[row],rowCount:1};};
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
  assert.equal(carriedTime.owedProblem('returned'),null);
  assert.equal(carriedTime.owedProblem('owed').reason,'carried_time_owed_after_renewal_loss');

  const writes=[];
  queryHandler=async(sql,params)=>{writes.push({sql,params});return{rows:[],rowCount:1};};
  await carriedTime.recordOperatorIncident({customerId:'cust',subscription:recurring,reason:'carried_time_failed'});
  assert(writes[0].sql.includes("'checkout_completion','open'")&&writes[0].sql.includes("'preserve'")&&writes[0].sql.includes('DO NOTHING'));
  assert.equal(writes[0].params[1],'carried_time_failed:target');
}

async function unpaidEnd(){
  const day=offset=>new Date(Date.UTC(2027,0,1)+offset*86400000);
  const run=async({priorStatus,priorEnd,incoming,status='cancelled',carried=true,hold=day(0)})=>{
    const db=client(sql=>{
      if(sql.includes('subscription_time_carryovers'))return carried?[{}]:[];
      if(sql.includes('customer_access_holds'))return hold?[{created_at:hold}]:[];
    });
    return carriedTime.paidEndWhenAgreementEnds(db,{prior:{id:'target',customer_id:'cust',status:priorStatus,current_period_end:priorEnd},status,periodEnd:incoming,provider:'stripe',providerSubscriptionId:'sub_1'});
  };
  assert.deepStrictEqual(await run({priorStatus:'past_due',priorEnd:day(365),incoming:day(365)}),day(0),'an unpaid period is not paid time');
  assert.deepStrictEqual(await run({priorStatus:'past_due',priorEnd:day(-1),incoming:null}),day(-1),'an unmoved end stays');
  assert.deepStrictEqual(await run({priorStatus:'cancelled',priorEnd:day(0),incoming:day(365)}),day(0),'a later delivery cannot restore it');
  assert.deepStrictEqual(await run({priorStatus:'active',priorEnd:day(30),incoming:day(30)}),day(30),'an ordinary end is untouched');
  assert.deepStrictEqual(await run({priorStatus:'past_due',priorEnd:day(365),incoming:day(365),carried:false}),day(365),'rows without carried time are untouched');
  assert.deepStrictEqual(await run({priorStatus:'past_due',priorEnd:day(365),incoming:day(365),status:'active'}),day(365));
  assert.deepStrictEqual(await run({priorStatus:'past_due',priorEnd:day(365),incoming:day(365),hold:null}),day(365));
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
  assert.deepStrictEqual(Array.from(compatibility.REQUIRED_FUNCTIONS).slice(-granted.length),granted,'grant list and required list must match');
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

  // Rounding up, the limit, one lock order, one carry per receiving row.
  const carry=body(statements,'carry_paid_time');
  assert(carry.includes('CEIL((candidate.carried_seconds::numeric*p_ratio)/86400)'));
  assert(carry.includes('>3650')&&carry.includes('RETURN -1'));
  assert(carry.indexOf('FROM customers')<carry.indexOf('pg_advisory_xact_lock')&&carry.indexOf('pg_advisory_xact_lock')<carry.indexOf('FROM subscriptions WHERE id=p_target FOR UPDATE'));
  assert(body(statements,'carry_all_paid_time').includes("'already',TRUE"));

  // Refund lock and reversal, including a web process without this change.
  const earlier=read(`db/migrations/${PREVIOUS}`).replace(/--.*$/gm,'');
  const afterLock=text=>{const guard=body(text,'enforce_provider_refund_cash_basis');return guard.slice(guard.indexOf("IF NEW.incident_type <> 'refund'")).replace(/\s+/g,' ');};
  assert.equal(afterLock(statements),afterLock(earlier),'the cash-basis refusals are unchanged');
  const lock=body(statements,'enforce_provider_refund_cash_basis');
  assert(lock.includes("NEW.incident_type='chargeback'")&&lock.includes('FOR UPDATE'));
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

  const primitives=read('src/payments/lifecycle-primitives.js');
  assert(primitives.indexOf('carriedTime.carryOnActivation(client, row)')<primitives.indexOf('syncProviderAccessState({ customerId: row.customer_id'));
  const intents=read('src/payments/checkout-intents.js');
  assert(intents.indexOf('lockCheckoutOwner(client, customerId)')<intents.indexOf('carriedTime.assertCarryPossible')&&intents.indexOf('carriedTime.assertCarryPossible')<intents.indexOf('INSERT INTO billing_checkout_intents'),'refused before a checkout exists');
}

(async()=>{
  contracts();
  await beforeMoney();
  await activation();
  await unpaidEnd();
  console.log('carried-time renewal smoke: ok');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
