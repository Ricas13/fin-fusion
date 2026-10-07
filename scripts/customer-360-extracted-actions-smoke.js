'use strict';

const assert=require('assert');
const path=require('path');

const root=path.join(__dirname,'..');
const modulePath=relative=>require.resolve(path.join(root,relative));
function stub(relative,exports){
  const filename=modulePath(relative);
  require.cache[filename]={id:filename,filename,loaded:true,exports};
}

const customerId='11111111-1111-4111-8111-111111111111';
const subscriptionId='22222222-2222-4222-8222-222222222222';
const actorUserId='33333333-3333-4333-8333-333333333333';
const planId='44444444-4444-4444-8444-444444444444';
const end=new Date('2026-11-01T00:00:00.000Z');
const entitlement={
  id:subscriptionId,
  subscription_id:subscriptionId,
  customer_id:customerId,
  plan_id:planId,
  service_type:'jellyfin',
  service_type_snapshot:'jellyfin',
  starts_at:new Date('2026-10-01T00:00:00.000Z'),
  duration_days:31,
  duration_days_snapshot:31,
  billing_interval:'custom',
  source:'manual',
  billing_mode:'manual'
};

let txQueries=[];
let reconciled=[];
stub('src/db.js',{
  query:async()=>({rows:[],rowCount:0}),
  transaction:async fn=>fn({
    query:async(sql,params=[])=>{
      const compact=String(sql).replace(/\s+/g,' ').trim();
      txQueries.push({sql:compact,params});
      if(compact.startsWith('SELECT id FROM subscriptions'))return{rows:[{id:subscriptionId}],rowCount:1};
      if(compact.startsWith('SELECT s.*,p.is_free_tier')&&compact.includes('FOR UPDATE OF s'))return{rows:[{
        ...entitlement,
        id:subscriptionId,
        status:'trialing',
        billing_interval:'trial',
        billing_interval_snapshot:'trial',
        duration_days:1,
        duration_days_snapshot:1,
        current_period_end:new Date('2026-10-08T00:00:00.000Z'),
        service_extension_days:3,
        superseded_by:null,
        refund_terminated:false
      }],rowCount:1};
      if(compact.startsWith('UPDATE subscriptions SET starts_at='))return{rows:[{id:subscriptionId,status:'trialing'}],rowCount:1};
      if(compact.startsWith('UPDATE subscriptions SET current_period_end='))return{rows:[{id:subscriptionId}],rowCount:1};
      if(compact.includes("'admin.customer.expiry.reset_to_plan'"))return{rows:[{id:'audit'}],rowCount:1};
      if(compact.includes("'admin.customer.trial.reset_duration'"))return{rows:[{id:'trial-audit'}],rowCount:1};
      throw new Error('Unexpected expiry/trial transaction query: '+compact.slice(0,180));
    }
  })
});
stub('src/entitlements/subscription-state.js',{
  effectiveSubscription:async(id,options)=>{
    assert.strictEqual(id,customerId);
    assert.deepStrictEqual(options,{includeBlocked:true});
    return entitlement;
  },
  recurringProvider:()=>false
});
stub('src/entitlements/plan-expiry.js',{
  isFreeTier:()=>false,
  endForPlan:()=>end
});
stub('src/entitlements/access-holds.js',{});
stub('src/entitlements/service-admin-control.js',{});
stub('src/jellyfin/resilient-provisioning.js',{
  reconcileCustomer:async id=>{reconciled.push(id);return{};}
});
stub('src/jellyfin/provisioning-helpers.js',{});

const individual=require('../src/access/admin-customer-individual-action-service');

(async()=>{
  txQueries=[];
  reconciled=[];
  const reset=await individual.resetExpiryToPlan({customerId,actorUserId});
  assert.strictEqual(reset.subscriptionId,subscriptionId,'reset-to-plan expiry must target the canonical effective subscription');
  assert.strictEqual(reset.end.toISOString(),end.toISOString(),'reset-to-plan expiry must use the plan-expiry owner');
  assert(txQueries[0].sql.includes('FOR UPDATE'),'reset-to-plan expiry must lock the selected subscription before mutation');
  const update=txQueries.find(row=>row.sql.startsWith('UPDATE subscriptions SET current_period_end='));
  assert(update,'reset-to-plan expiry must update the selected subscription');
  assert.strictEqual(update.params[0],subscriptionId);
  assert.strictEqual(update.params[2],customerId,'expiry mutation must stay customer-scoped');
  assert(update.sql.includes('service_extension_days=0'),'reset-to-plan expiry must clear manual extension days');
  const audit=txQueries.find(row=>row.sql.includes("'admin.customer.expiry.reset_to_plan'"));
  assert(audit,'reset-to-plan expiry and audit must share the transaction');
  assert.deepStrictEqual(reconciled,[customerId],'expiry reset must reconcile access after the transaction');

  txQueries=[];
  reconciled=[];
  const trialReset=await individual.resetTrial({customerId,actorUserId,subscriptionId});
  assert.strictEqual(trialReset.subId,subscriptionId,'trial reset must target the explicitly selected subscription');
  assert.strictEqual(trialReset.durationDays,1,'trial reset must preserve the contracted trial duration');
  assert.strictEqual(trialReset.end.getTime()-trialReset.start.getTime(),86400000,'one-day trial reset must grant exactly a fresh 24 hours');
  const trialUpdate=txQueries.find(row=>row.sql.startsWith('UPDATE subscriptions SET starts_at='));
  assert(trialUpdate,'trial reset must update start and end together');
  assert(trialUpdate.sql.includes('service_extension_days=0'),'trial reset must clear stale manual extensions');
  assert(trialUpdate.sql.includes('cancel_at_period_end=FALSE'),'trial reset must leave the refreshed trial active for its full new term');
  assert.strictEqual(trialUpdate.params[0],subscriptionId);
  assert.strictEqual(trialUpdate.params[3],customerId,'trial reset mutation must stay customer-scoped');
  const trialAudit=txQueries.find(row=>row.sql.includes("'admin.customer.trial.reset_duration'"));
  assert(trialAudit,'trial reset must be audited in the same transaction as its date mutation');
  assert.deepStrictEqual(reconciled,[customerId],'trial reset must reconcile service access without rotating existing credentials');

  // Re-load the lifecycle service with placement-specific collaborators.
  delete require.cache[modulePath('src/access/admin-customer-lifecycle-service.js')];
  let currentAccount=null;
  let target={id:'server-target',name:'Target'};
  let reconcileCount=0;
  let createdMigration=null;
  let executedMigration=null;
  stub('src/entitlements/subscription-state.js',{
    effectiveSubscription:async()=>entitlement,
    assertAudience:value=>value,
    recurringProvider:()=>false
  });
  stub('src/entitlements/service-scope.js',{
    capabilities:()=>new Set(['jellyfin']),
    overlaps:()=>true,
    label:()=> 'Jellyfin'
  });
  stub('src/entitlements/plan-expiry.js',{
    isFreeTier:()=>false,
    endForPlan:()=>end
  });
  stub('src/payments/customer-plan-change.js',{contractSnapshot:()=>({}),currentRecurring:async()=>null});
  stub('src/payments/plan-pricing.js',{resolvePrice:async()=>null});
  stub('src/jellyfin/resilient-provisioning.js',{
    selectServerForPlan:async seen=>{
      assert.strictEqual(seen,entitlement,'automatic placement must use the canonical effective entitlement');
      return target;
    },
    reconcileCustomer:async id=>{
      reconcileCount++;
      assert.strictEqual(id,customerId);
      return{account:{server_name:'Target'}};
    }
  });
  stub('src/jellyfin/admin-force-move.js',{move:async()=>({})});
  stub('src/jellyfin/server-migration.js',{
    primaryAccount:async()=>currentAccount,
    createMigration:async(id,targetId,actor)=>{
      createdMigration={id,targetId,actor};
      return{id:'migration-1'};
    },
    executeMigration:async id=>{
      executedMigration=id;
      return{target_server_name:'Moved Target'};
    }
  });

  const lifecycle=require('../src/access/admin-customer-lifecycle-service');

  currentAccount=null;
  reconcileCount=0;
  let placed=await lifecycle.resetAutomaticPlacement(customerId,{actorUserId});
  assert.deepStrictEqual(placed,{mode:'placed',targetName:'Target'},'customer without an account must reconcile onto the selected automatic target');
  assert.strictEqual(reconcileCount,1,'missing-account placement must use canonical reconciliation');

  currentAccount={server_id:'server-target'};
  reconcileCount=0;
  let already=await lifecycle.resetAutomaticPlacement(customerId,{actorUserId});
  assert.deepStrictEqual(already,{mode:'already',targetName:'Target'},'customer already on the selected target must not create a migration');
  assert.strictEqual(reconcileCount,1,'already-correct placement must still reconcile policy/account state');

  currentAccount={server_id:'server-old'};
  reconcileCount=0;
  createdMigration=null;
  executedMigration=null;
  let moved=await lifecycle.resetAutomaticPlacement(customerId,{actorUserId});
  assert.deepStrictEqual(moved,{mode:'moved',targetName:'Moved Target'},'different automatic target must use the migration owner');
  assert.deepStrictEqual(createdMigration,{id:customerId,targetId:'server-target',actor:actorUserId},'migration creation must preserve customer, target and actor');
  assert.strictEqual(executedMigration,'migration-1','automatic placement must execute the durable migration it created');
  assert.strictEqual(reconcileCount,0,'migration path must not run a second broad reconciliation outside migration ownership');

  target=null;
  await assert.rejects(
    ()=>lifecycle.resetAutomaticPlacement(customerId,{actorUserId}),
    /No eligible server is currently available/,
    'automatic placement must fail closed when no eligible target exists'
  );

  console.log('Customer 360 extracted expiry/automatic-placement behavior smoke: ok');
})().catch(error=>{
  console.error(error);
  process.exit(1);
});
