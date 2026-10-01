'use strict';

const assert=require('assert');
const path=require('path');

const root=path.join(__dirname,'..');
function modulePath(relative){return require.resolve(path.join(root,relative));}
function stub(relative,exports){const filename=modulePath(relative);require.cache[filename]={id:filename,filename,loaded:true,exports};}

let entitlement=null;
let recurring=false;
let primaryAccount=null;
let selectedServer=null;
let reconcileResult={account:{server_name:'Auto Server'}};
let reconciled=0;
let migrationCreated=null;
let migrationExecuted=null;
let txQueries=[];
let lockAvailable=true;

const subscriptionState={
  effectiveSubscription:async()=>entitlement,
  recurringProvider:()=>recurring,
  assertAudience:value=>value
};

const db={
  query:async()=>({rows:[],rowCount:0}),
  transaction:async fn=>fn({
    query:async(sql,params=[])=>{
      txQueries.push({sql:String(sql).replace(/\s+/g,' ').trim(),params});
      if(String(sql).includes('SELECT id FROM subscriptions')&&String(sql).includes('FOR UPDATE')){
        return {rows:lockAvailable?[{id:params[0]}]:[],rowCount:lockAvailable?1:0};
      }
      if(String(sql).includes('UPDATE subscriptions SET current_period_end=')){
        return {rows:[{id:params[0]}],rowCount:1};
      }
      if(String(sql).includes('INSERT INTO audit_log')){
        return {rows:[{id:'audit'}],rowCount:1};
      }
      throw new Error('Unexpected transaction query: '+String(sql).replace(/\s+/g,' ').slice(0,180));
    }
  })
};

stub('src/db.js',db);
stub('src/entitlements/subscription-state.js',subscriptionState);
stub('src/entitlements/service-scope.js',{
  capabilities:()=>new Set(['jellyfin']),
  overlaps:()=>true,
  label:()=> 'Jellyfin'
});
const fixedEnd=new Date('2026-11-01T12:00:00.000Z');
stub('src/entitlements/plan-expiry.js',{
  endForPlan:()=>fixedEnd,
  isFreeTier:()=>false
});
stub('src/payments/customer-plan-change.js',{
  contractSnapshot:()=>({}),
  currentRecurring:async()=>null,
  requestChange:async()=>({handled:true})
});
stub('src/payments/plan-pricing.js',{resolvePrice:async()=>({id:'price',price_minor:600,currency:'GBP'})});
stub('src/jellyfin/resilient-provisioning.js',{
  selectServerForPlan:async()=>selectedServer,
  reconcileCustomer:async()=>{reconciled+=1;return reconcileResult;}
});
stub('src/jellyfin/admin-force-move.js',{move:async()=>({})});
stub('src/jellyfin/server-migration.js',{
  primaryAccount:async()=>primaryAccount,
  createMigration:async(customerId,serverId,actorUserId)=>{
    migrationCreated={customerId,serverId,actorUserId};
    return {id:'migration-1'};
  },
  executeMigration:async id=>{
    migrationExecuted=id;
    return {target_server_name:'Moved Server'};
  }
});
stub('src/entitlements/access-holds.js',{addHold:async()=>{}});
stub('src/entitlements/service-admin-control.js',{setRemoved:async()=>{}});
stub('src/jellyfin/provisioning-helpers.js',{deleteJellyfinAccount:async()=>{}});

const lifecycle=require('../src/access/admin-customer-lifecycle-service');
const individual=require('../src/access/admin-customer-individual-action-service');

async function placementCases(){
  entitlement=null;
  await assert.rejects(
    ()=>lifecycle.resetAutomaticPlacement('customer',{actorUserId:'actor'}),
    /no active Jellyfin entitlement/
  );

  entitlement={id:'sub',service_type:'jellyfin'};
  selectedServer=null;
  await assert.rejects(
    ()=>lifecycle.resetAutomaticPlacement('customer',{actorUserId:'actor'}),
    /No eligible server/
  );

  selectedServer={id:'server-a',name:'Server A'};
  primaryAccount=null;
  reconciled=0;
  const placed=await lifecycle.resetAutomaticPlacement('customer',{actorUserId:'actor'});
  assert.deepStrictEqual(placed,{mode:'placed',targetName:'Auto Server'});
  assert.strictEqual(reconciled,1,'customer without an account must be placed through canonical reconciliation');

  primaryAccount={server_id:'server-a'};
  reconciled=0;
  migrationCreated=null;
  const already=await lifecycle.resetAutomaticPlacement('customer',{actorUserId:'actor'});
  assert.deepStrictEqual(already,{mode:'already',targetName:'Server A'});
  assert.strictEqual(reconciled,1,'already-correct placement must still reconcile desired policy');
  assert.strictEqual(migrationCreated,null,'already-correct placement must not create a migration');

  primaryAccount={server_id:'server-old'};
  selectedServer={id:'server-new',name:'Server New'};
  migrationCreated=null;
  migrationExecuted=null;
  const moved=await lifecycle.resetAutomaticPlacement('customer',{actorUserId:'actor-2'});
  assert.deepStrictEqual(moved,{mode:'moved',targetName:'Moved Server'});
  assert.deepStrictEqual(migrationCreated,{customerId:'customer',serverId:'server-new',actorUserId:'actor-2'});
  assert.strictEqual(migrationExecuted,'migration-1','different placement must execute the created migration');
}

async function expiryCases(){
  entitlement={
    id:'subscription-1',
    subscription_id:'subscription-1',
    plan_id:'plan-1',
    source:'admin'
  };
  recurring=true;
  txQueries=[];
  await assert.rejects(
    ()=>individual.resetExpiryToPlan({customerId:'customer',actorUserId:'actor'}),
    /controlled by Stripe\/PayPal/
  );
  assert.strictEqual(txQueries.length,0,'provider-controlled expiry must fail before opening a write transaction');

  recurring=false;
  lockAvailable=true;
  reconciled=0;
  txQueries=[];
  const result=await individual.resetExpiryToPlan({customerId:'customer',actorUserId:'actor'});
  assert.strictEqual(result.subscriptionId,'subscription-1');
  assert.strictEqual(result.end.toISOString(),fixedEnd.toISOString());
  assert.strictEqual(txQueries.length,3,'expiry reset must lock, update and audit in one transaction');
  assert(txQueries[0].sql.includes('FOR UPDATE'),'expiry reset must lock the exact customer subscription before mutation');
  assert(txQueries[1].sql.includes('service_extension_days=0'),'expiry reset must clear service extensions atomically');
  assert(txQueries[2].sql.includes("admin.customer.expiry.reset_to_plan"),'expiry reset audit must be part of the same transaction');
  assert.strictEqual(reconciled,1,'successful expiry reset must reconcile access after commit');

  lockAvailable=false;
  reconciled=0;
  txQueries=[];
  await assert.rejects(
    ()=>individual.resetExpiryToPlan({customerId:'customer',actorUserId:'actor'}),
    /active subscription changed/
  );
  assert.strictEqual(txQueries.length,1,'lost subscription lock must prevent update and audit');
  assert.strictEqual(reconciled,0,'failed expiry reset must not reconcile a mutation that never committed');
}

(async()=>{
  await placementCases();
  await expiryCases();
  console.log('Customer 360 extracted placement/expiry behavior smoke: ok');
})().catch(error=>{
  console.error(error);
  process.exit(1);
});
