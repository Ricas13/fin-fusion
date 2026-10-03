'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const capacity = require('../src/entitlements/plan-capacity');

(async () => {
  const suffix = crypto.randomBytes(5).toString('hex');
  let serverId = null;
  let previousFreePlan = null;
  let freeTestMappingAdded = false;
  const planIds = [];
  const customerIds = [];
  try {
    const server = await query(`
      INSERT INTO jellyfin_servers(
        name,slug,server_class,media_server_type,base_url,api_key_encrypted,
        enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,
        health_status,last_health_check,placement_mode
      ) VALUES($1,$2,'custom','jellyfin','https://capacity.invalid','key',
        TRUE,TRUE,TRUE,TRUE,1,200,'healthy',NOW(),'active')
      RETURNING id
    `, [`Capacity ${suffix}`, `capacity-${suffix}`]);
    serverId = server.rows[0].id;

    async function makePlan(code, mediaUserLimit) {
      const row = (await query(`
        INSERT INTO plans(
          code,name,description,service_type,audience,billing_interval,duration_days,
          price_minor,currency,capacity_limit,inactivity_policy,is_addon,server_class,
          visible,active,streams
        ) VALUES($1,$2,'capacity smoke','jellyfin','direct','month',30,500,'GBP',$3,$4::jsonb,FALSE,'custom',TRUE,TRUE,1)
        RETURNING id
      `, [code, code, mediaUserLimit, JSON.stringify({ mediaCapacityManaged: true })])).rows[0];
      planIds.push(row.id);
      await query(`INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)`, [row.id, serverId]);
      return row.id;
    }

    const limitedPlan = await makePlan(`capacity-limited-${suffix}`, 50);
    let state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.model, 'fleet_users');
    assert.strictEqual(state.physicalUserLimit, 200, 'physical fleet ceiling must come from server max_users');
    assert.strictEqual(state.planUserLimit, 50, 'plan ceiling must be independent from physical capacity');
    assert.strictEqual(state.limit, 50, 'effective capacity must use the lower plan ceiling');
    assert.strictEqual(state.remaining, 50);

    await query(`UPDATE plans SET capacity_limit=NULL WHERE id=$1`, [limitedPlan]);
    state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.planUserLimit, null, 'NULL plan ceiling means use the eligible physical fleet');
    assert.strictEqual(state.limit, 200);
    assert.strictEqual(state.remaining, 200);

    await query(`UPDATE plans SET capacity_limit=300 WHERE id=$1`, [limitedPlan]);
    state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.planUserLimit, 300);
    assert.strictEqual(state.limit, 200, 'plan configuration must never manufacture capacity beyond the servers');
    assert.strictEqual(state.remaining, 200);

    await query(`UPDATE plans SET capacity_limit=50 WHERE id=$1`, [limitedPlan]);

    const planCustomer = (await query(
      `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
      [`Plan customer ${suffix}`, `plan-${suffix}@example.invalid`]
    )).rows[0];
    customerIds.push(planCustomer.id);
    await query(`
      INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
      VALUES($1,$2,'active','manual',NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days')
    `, [planCustomer.id, limitedPlan]);
    await query(`
      INSERT INTO jellyfin_accounts(
        customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,
        account_purpose,access_lane,is_primary
      ) VALUES($1,$2,$3,$4,FALSE,'jellyfin','primary',TRUE)
    `, [planCustomer.id, serverId, `remote-plan-${suffix}`, `plan_${suffix}`]);

    const otherPlan = await makePlan(`capacity-other-${suffix}`, null);
    const otherCustomer = (await query(
      `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
      [`Other customer ${suffix}`, `other-${suffix}@example.invalid`]
    )).rows[0];
    customerIds.push(otherCustomer.id);
    await query(`
      INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
      VALUES($1,$2,'active','manual',NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days')
    `, [otherCustomer.id, otherPlan]);
    await query(`
      INSERT INTO jellyfin_accounts(
        customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,
        account_purpose,access_lane,is_primary
      ) VALUES($1,$2,$3,$4,FALSE,'jellyfin','primary',TRUE)
    `, [otherCustomer.id, serverId, `remote-other-${suffix}`, `other_${suffix}`]);

    state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.planUsed, 1, 'plan usage must count only customers of this product');
    assert.strictEqual(state.managedUsers, 2, 'physical usage must count all managed customers on eligible servers');
    assert.strictEqual(state.planRemaining, 49);
    assert.strictEqual(state.physicalRemaining, 198);
    assert.strictEqual(state.remaining, 49, 'effective availability must be the lower of plan and physical remaining capacity');

    await query(`UPDATE plans SET capacity_limit=500 WHERE id=$1`, [limitedPlan]);
    state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.remaining, 198, 'when plan ceiling exceeds infrastructure, physical remaining capacity must win');


    const available = async () => (await query('SELECT '+capacity.acquisitionSql('p')+' AS available FROM plans p WHERE id=$1',[limitedPlan])).rows[0].available;
    await query('UPDATE plans SET capacity_limit=1 WHERE id=$1',[limitedPlan]);
    assert.equal(await available(),false,'storefront must enforce plan cap');
    await query("UPDATE subscriptions SET status='expired',current_period_end=NOW()-INTERVAL '1 day',service_extension_days=3 WHERE customer_id=$1",[planCustomer.id]);
    assert.equal((await capacity.usage(limitedPlan)).planUsed,1);
    assert.equal(await available(),false,'extended episodes must occupy capacity in storefront SQL too');
    await query('UPDATE subscriptions SET service_extension_days=0 WHERE customer_id=$1',[planCustomer.id]);
    await query("INSERT INTO customer_entitlement_overrides(customer_id,subscription_id,permanent_access) SELECT customer_id,id,TRUE FROM subscriptions WHERE customer_id=$1",[planCustomer.id]);
    assert.equal((await capacity.usage(limitedPlan)).planUsed,1);
    assert.equal(await available(),false,'permanent episodes must occupy storefront capacity');
    await query('DELETE FROM customer_entitlement_overrides WHERE customer_id=$1',[planCustomer.id]);
    await query("INSERT INTO customer_service_admin_control(customer_id,service,mode) VALUES($1,'jellyfin','admin_present')",[planCustomer.id]);
    assert.equal((await capacity.usage(limitedPlan)).planUsed,1);
    assert.equal(await available(),false,'manual presence must occupy storefront capacity');
    await query('DELETE FROM customer_service_admin_control WHERE customer_id=$1',[planCustomer.id]);
    await query("UPDATE plans SET inactivity_policy='{}',capacity_limit=0 WHERE id=$1",[limitedPlan]);
    assert.equal((await capacity.usage(limitedPlan)).planUserLimit,null);
    assert.equal(await available(),true,'legacy zero must not close acquisition');
    await query('UPDATE plans SET capacity_limit=1 WHERE id=$1',[limitedPlan]);
    assert.equal(await available(),true,'legacy positive limits must remain inert too');

    // Explicit pools override class, including shared pending occupancy across classes.
    await query("UPDATE plans SET server_class='premium' WHERE id=$1",[limitedPlan]);
    const pool = await require('../src/jellyfin/plan-servers').eligibleServersForPlan({id:limitedPlan,server_class:'premium',service_type:'jellyfin'});
    assert(pool.some(row=>row.id===serverId),'selected custom server must serve premium-class plan');
    await query('DELETE FROM jellyfin_accounts WHERE customer_id=$1',[otherCustomer.id]);
    state=await capacity.usage(limitedPlan);
    assert.equal(state.pendingUsers,1,'overlapping cross-class plan must reserve physical space');
    await query('UPDATE jellyfin_servers SET max_users=2 WHERE id=$1',[serverId]);
    assert.equal((await capacity.usage(limitedPlan)).remaining,0);
    assert.equal(await available(),false,'storefront and live usage must agree on shared physical occupancy');
    // A mapping for the other provider must not suppress Jellyfin class fallback.
    const embyServer=(await query("INSERT INTO jellyfin_servers(name,slug,server_class,media_server_type,base_url,api_key_encrypted) VALUES($1,$2,'custom','emby','https://capacity.invalid','key') RETURNING id",['Other provider '+suffix,'other-provider-'+suffix])).rows[0];
    try {
      await query("UPDATE plans SET server_class='custom' WHERE id=$1",[limitedPlan]);
      await query('UPDATE plan_server_eligibility SET server_id=$2 WHERE plan_id=$1',[limitedPlan,embyServer.id]);
      const fallback=await capacity.usage(limitedPlan);
      assert.equal(fallback.pendingUsers,1,'other-provider mappings must not hide pending Jellyfin customers');
      assert.equal(fallback.remaining,0,'other-provider mappings must not reopen a full Jellyfin pool');
      assert.equal(await available(),false,'storefront and live fallback must agree');
    } finally {
      await query('UPDATE plan_server_eligibility SET server_id=$2 WHERE plan_id=$1',[limitedPlan,serverId]);
      await query("UPDATE plans SET server_class='premium' WHERE id=$1",[limitedPlan]);
      await query('DELETE FROM jellyfin_servers WHERE id=$1',[embyServer.id]);
    }
    await query('UPDATE jellyfin_servers SET max_users=200 WHERE id=$1',[serverId]);


    // The previous release holds only the class lock during rolling deploys.
    const oldGeneration=await getPool().connect(),newGeneration=await getPool().connect();
    try {
      await oldGeneration.query('BEGIN');
      await oldGeneration.query("SELECT pg_advisory_xact_lock(hashtextextended('captainfin:capacity:fleet-users:premium',77133))");
      await newGeneration.query('BEGIN');
      await newGeneration.query("SET LOCAL lock_timeout='150ms'");
      await assert.rejects(()=>capacity.lockAndAssert(newGeneration,limitedPlan),error=>error.code==='55P03','new generation must wait for the old generation capacity lock');
    } finally {
      await newGeneration.query('ROLLBACK');
      await oldGeneration.query('ROLLBACK');
      oldGeneration.release();newGeneration.release();
    }

    // Competing acquisitions in different classes share the same physical pool.
    await query('UPDATE jellyfin_servers SET max_users=3 WHERE id=$1',[serverId]);
    const racers=[];
    for(let i=0;i<2;i++){
      const c=(await query('INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',['Race '+i,'race-'+i+'-'+suffix+'@example.invalid'])).rows[0];
      customerIds.push(c.id);racers.push(c.id);
    }
    const outcomes=await Promise.allSettled(racers.map(async(customerId,index)=>{
      const client=await getPool().connect();
      try{
        await client.query('BEGIN');
        const planId=index?otherPlan:limitedPlan;
        await capacity.lockAndAssert(client,planId);
        await client.query("INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')",[customerId,planId]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }));
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1,'only one competing acquisition may take the final physical place');
    const rejected=outcomes.find(r=>r.status==='rejected');
    assert.match(rejected.reason.message,/sold out/i);
    await query('UPDATE jellyfin_servers SET max_users=200 WHERE id=$1',[serverId]);

    // A plan window longer than the server window must retain older valid playback.
    const commands=require('../src/catalog/plan-command-service');
    const policy={firstPlaybackGraceDays:3,playbackWindowDays:14,minimumPlaybackMinutes:30};
    previousFreePlan=(await query('SELECT id,capacity_limit,inactivity_policy FROM plans WHERE is_free_tier=TRUE')).rows[0];
    const freePlanId=previousFreePlan.id;
    const existingFreeTestMapping=await query('SELECT 1 FROM plan_server_eligibility WHERE plan_id=$1 AND server_id=$2',[freePlanId,serverId]);
    if(!existingFreeTestMapping.rowCount){
      await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)',[freePlanId,serverId]);
      freeTestMappingAdded=true;
    }
    await commands.updateMediaUserLimit({planId:freePlanId,mediaUserLimit:10,freeInactivityPolicy:policy});
    await query("UPDATE subscriptions SET plan_id=$2,status='active',starts_at=NOW()-INTERVAL '20 days',current_period_end=NOW()+INTERVAL '30 days' WHERE customer_id=$1",[planCustomer.id,freePlanId]);
    const account=(await query("UPDATE jellyfin_accounts SET access_lane='free',created_at=NOW()-INTERVAL '20 days',access_lane_changed_at=NOW()-INTERVAL '20 days' WHERE customer_id=$1 RETURNING id",[planCustomer.id])).rows[0];
    for(const [days,minutes] of [[19,1],[10,40]])await query("INSERT INTO playback_history(customer_id,server_id,jellyfin_account_id,playback_key,jellyfin_session_id,started_at,last_seen_at,ended_at) VALUES($1,$2,$3,$4,$4,NOW()-($5||' days')::interval,NOW()-($5||' days')::interval+($6||' minutes')::interval,NOW()-($5||' days')::interval+($6||' minutes')::interval)",[planCustomer.id,serverId,account.id,suffix+'-'+days,String(days),String(minutes)]);
    const inactivity=require('../src/automation/customer-inactivity');
    const candidate=async()=> (await inactivity.candidates({enabled:true,dryRun:true},{customerId:planCustomer.id}))[0];
    let row=await candidate();
    assert.equal(Number(row.playback_seconds),2400,'plan window must apply to filtering and duration calculation');
    assert.equal(row.eligible,false,'valid playback must prevent removal');
    for(const bad of [{playbackWindowDays:14},{...policy,firstPlaybackGraceDays:'oops'},{...policy,minimumPlaybackMinutes:'999999999999999999999'}]){
      await query("UPDATE plans SET inactivity_policy=jsonb_build_object('freeInactivity',$2::jsonb) WHERE id=$1",[freePlanId,JSON.stringify(bad)]);
      row=await candidate();
      assert.equal(row.plan_free_playback_window_days,null,'incomplete or invalid policy must fall back as a whole');
      assert.equal(Number(row.playback_seconds),0,'SQL must use legacy seven-day window after fallback');
    }
    await query("UPDATE plans SET inactivity_policy=jsonb_build_object('freeInactivity',$2::jsonb) WHERE id=$1",[freePlanId,JSON.stringify(policy)]);
    await commands.updateMediaUserLimit({planId:freePlanId,mediaUserLimit:20});
    const saved=(await query('SELECT capacity_limit,inactivity_policy FROM plans WHERE id=$1',[freePlanId])).rows[0];
    assert.deepStrictEqual(saved.inactivity_policy.freeInactivity,policy,'capacity save must preserve thresholds');
    await assert.rejects(()=>commands.updateMediaUserLimit({planId:freePlanId,mediaUserLimit:0,freeInactivityPolicy:{playbackWindowDays:14}}),/Invalid Free/);
    assert.equal((await query('SELECT capacity_limit FROM plans WHERE id=$1',[freePlanId])).rows[0].capacity_limit,20,'invalid policy must not partially save capacity');

    console.log('plan-owned media capacity DB smoke: ok');
  } finally {
    if (customerIds.length) await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [customerIds]).catch(() => {});
    if (planIds.length) await query('DELETE FROM plans WHERE id=ANY($1::uuid[])', [planIds]).catch(() => {});
    if(previousFreePlan)await query("UPDATE plans SET capacity_limit=$2,inactivity_policy=$3::jsonb WHERE id=$1",[previousFreePlan.id,previousFreePlan.capacity_limit,JSON.stringify(previousFreePlan.inactivity_policy)]);
    if(freeTestMappingAdded&&previousFreePlan&&serverId)await query('DELETE FROM plan_server_eligibility WHERE plan_id=$1 AND server_id=$2',[previousFreePlan.id,serverId]).catch(()=>{});
    if (serverId) await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
    await getPool().end();
  }
})().catch(async error => {
  console.error(error);
  try { await getPool().end(); } catch (_) {}
  process.exit(1);
});
