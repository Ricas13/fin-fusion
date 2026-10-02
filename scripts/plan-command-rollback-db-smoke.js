'use strict';

const assert=require('assert');
const {query}=require('../src/db');
const {runDbSmoke}=require('./test-fixture');
const planCommands=require('../src/catalog/plan-command-service');

const CODE='audit-plan-command-rollback';

async function cleanup(){
  await query('DELETE FROM plans WHERE code=$1',[CODE]);
}

runDbSmoke('catalog plan command rollback DB smoke',async()=>{
  await cleanup();

  try{
    const created=await planCommands.createPlan({
      code:CODE,
      name:'Rollback Baseline',
      description:'Plan command transaction rollback fixture',
      planKind:'paid_jellyfin',
      serviceType:'jellyfin',
      audience:'direct',
      billing:'month',
      duration:30,
      priceMinor:900,
      currency:'GBP',
      capacityLimit:0,
      isAddon:false,
      serverClass:'premium',
      visible:false,
      active:false,
      jellyfinAccessModel:'concurrent_streams',
      jellyfinHouseholdNetworkLimit:1,
      jellyfinHouseholdLeaseMinutes:240,
      stremioHouseholdNetworkLimit:1,
      stremioHouseholdLeaseMinutes:240,
      stremioIpReplacementPolicy:'customer_cooldown',
      stremioIpReplacementCooldownMinutes:1440,
      streams:1,
      downloads:false,
      video:false,
      audio:true,
      remux:false,
      live:false,
      liveManagement:false,
      remote:true,
      fourk:false,
      subtitles:false,
      libraryMode:'all',
      libraries:[],
      inactivityPolicy:{}
    },null);

    const before=(await query(
      'SELECT name,description,server_class,visible,active FROM plans WHERE id=$1',
      [created.id]
    )).rows[0];

    let failed=null;
    try{
      await planCommands.updatePlanOverview({
        planId:created.id,
        input:{
          name:'Must Roll Back',
          description:'This update must never commit',
          audience:'direct',
          billing:'year',
          duration:365,
          serverClass:'custom',
          visible:true,
          active:true,
          sort:999,
          features:['should-not-persist'],
          discordRoleId:null
        },
        // audit_log.actor_user_id is UUID-backed. This intentionally fails the
        // final audit write after the plan UPDATE has executed.
        actorUserId:'not-a-uuid',
        auditMetadata:{test:'rollback'}
      });
    }catch(error){
      failed=error;
    }

    assert(failed,'the forced audit failure must reject the plan command');

    const after=(await query(
      'SELECT name,description,server_class,visible,active FROM plans WHERE id=$1',
      [created.id]
    )).rows[0];
    assert.deepStrictEqual(after,before,'a failed audit write must roll back the entire plan mutation transaction');

    const audit=(await query(
      "SELECT COUNT(*)::int n FROM audit_log WHERE entity_type='plan' AND entity_id=$1 AND action='admin.plan.update'",
      [created.id]
    )).rows[0];
    assert.strictEqual(Number(audit.n),0,'failed plan update must not leave a partial audit event');

  }finally{
    await cleanup();
  }
});
