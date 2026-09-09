'use strict';

const assert=require('assert');
const crypto=require('crypto');
const {query}=require('../src/db');
const pending=require('../src/security/pending-registration');
const capacity=require('../src/entitlements/plan-capacity');
const lifecycle=require('../src/payments/lifecycle');
const recoverySmoke=require('./jellyfin-account-creation-recovery-db-smoke');
const {encryptWithEnv}=require('../src/security/purpose-crypto');

async function main(){
  const free=(await query(`SELECT id,code,capacity_limit FROM plans WHERE is_free_tier=TRUE LIMIT 1`)).rows[0];
  assert(free,'canonical Free Access plan is missing');
  assert.equal(pending.FREE_INTENT_MINUTES,10,'anonymous Free Access signup intent must stay short');

  const originalLimit=free.capacity_limit;
  const tag=`intent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const intentIds=[];
  const pendingIds=[];
  const reservationIds=[];
  let created=null,subscriptionId=null,terminal=null,duplicateUserId=null,serverId=null;

  try{
    const testApiKey=encryptWithEnv(`test-${tag}`,'JELLYFIN_ENCRYPTION_KEY','jf1');
    serverId=(await query(`
      INSERT INTO jellyfin_servers(
        name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,
        enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled,placement_mode
      )
      VALUES($1,$2,'free','jellyfin','https://example.invalid','https://example.invalid',$3,
             TRUE,1,10000,'healthy',TRUE,TRUE,TRUE,'active')
      RETURNING id
    `,[`${tag}-server`,`${tag}-server`,testApiKey])).rows[0].id;
    await query(`INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)`,[free.id,serverId]);

    // Release-critical scenario: production is 80/80, an operator raises the
    // Free Jellyfin server to 90, and the same process must immediately expose
    // exactly ten additional customer places.
    await query(`
      INSERT INTO customers(display_name,email,registration_source)
      SELECT $1||'-capacity-'||g,$1||'-capacity-'||g||'@example.test','public'
      FROM generate_series(1,80) AS g
    `,[tag]);
    await query(`
      INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose)
      SELECT id,$2,'capacity-'||id::text,'capacity-'||substr(id::text,1,18),FALSE,'jellyfin'
      FROM customers WHERE email LIKE $1
    `,[`${tag}-capacity-%@example.test`,serverId]);

    await query(`UPDATE jellyfin_servers SET max_users=80,updated_at=NOW() WHERE id=$1`,[serverId]);
    const at80=await capacity.usage(free.id);
    assert.equal(at80.model,'fleet_users','Free Access must use server customer-user capacity');
    assert.equal(at80.userUsed,80,'80 managed Free customers did not consume exactly 80 places');
    assert.equal(at80.limit,80,'server max_users=80 was not authoritative Free capacity');
    assert.equal(at80.remaining,0,'80/80 Free server was not sold out');

    await query(`UPDATE jellyfin_servers SET max_users=90,updated_at=NOW() WHERE id=$1`,[serverId]);
    const at90=await capacity.usage(free.id);
    assert.equal(at90.userUsed,80,'raising the limit changed the managed-user count');
    assert.equal(at90.limit,90,'server max_users=90 was not picked up immediately');
    assert.equal(at90.remaining,10,'80/90 did not expose exactly ten Free places without restart');

    // Anonymous browsers may start signup concurrently, but those intents are
    // deliberately non-scarce and must not consume any of the ten places.
    const sessions=Array.from({length:11},(_,index)=>`${tag}:burst-${index+1}`);
    const intentBurst=await Promise.all(sessions.map(sessionId=>pending.reserveFreeAccess({sessionId})));
    assert.equal(intentBurst.length,11,'anonymous signup intents should not compete for the ten scarce places');
    intentBurst.forEach(intent=>intentIds.push(intent.id));
    const afterIntents=await capacity.usage(free.id);
    assert.equal(afterIntents.reservedUsers,0,'anonymous signup intents consumed Free capacity');
    assert.equal(afterIntents.remaining,10,'anonymous signup intents changed the 80/90 capacity result');

    // The scarce boundary is validated account submission. begin() serializes
    // registration and calls planCapacity.lockAndAssert before inserting the
    // pending-registration reservation, so exactly ten of eleven submissions
    // may win without oversubscription.
    const submissions=await Promise.allSettled(intentBurst.map((intent,index)=>pending.begin({
      email:`${tag}-burst-${index+1}@example.test`,
      username:`u_${crypto.randomBytes(10).toString('hex')}`.slice(0,40),
      password:'ReservationSmoke!2026',
      freeAccess:true,
      ttlMinutes:60,
      freeReservationId:intent.id,
      freeReservationSessionId:sessions[index]
    })));
    const accepted=submissions.filter(result=>result.status==='fulfilled').map(result=>result.value);
    const rejected=submissions.filter(result=>result.status==='rejected');
    assert.equal(accepted.length,10,'exactly ten validated Free registrations must reserve the ten open places');
    assert.equal(rejected.length,1,'the 11th validated Free registration was not rejected');
    assert.equal(rejected[0].reason?.message,'No free places currently available','the losing registration returned the wrong sold-out response');
    accepted.forEach(item=>{pendingIds.push(item.id);reservationIds.push(item.freeReservation.id);});

    const burstFull=await capacity.usage(free.id);
    assert.equal(burstFull.reservedUsers,10,'ten validated pending registrations did not reserve ten customer places');
    assert.equal(burstFull.remaining,0,'validated registration burst oversubscribed the 80/90 Free server');

    // Keep one winner for the verification/claim lifecycle and release the
    // other nine by deleting their unverified pending registrations. FK cascade
    // must immediately return those places.
    const first=accepted[0];
    for(const item of accepted.slice(1))await query(`DELETE FROM pending_registrations WHERE id=$1`,[item.id]);
    const oneHeld=await capacity.usage(free.id);
    assert.equal(oneHeld.reservedUsers,1,'deleting nine pending registrations did not release nine reservations');
    assert.equal(oneHeld.remaining,9,'released pending registrations did not immediately return capacity');

    const pendingExpiryMs=new Date(first.expires_at).getTime();
    assert.equal(new Date(first.freeReservation.expires_at).getTime(),pendingExpiryMs,'validated Free reservation must expire at the verification-token expiry');

    created=await pending.consume(first.token);
    assert(created?.freeAccessRequested,'verified registration lost Free Access intent');
    assert.equal(String(created.freeReservation?.id),String(first.freeReservation.id),'verified registration did not retain its real reservation');

    try{
      const sub=await lifecycle.claimFreePlan(created.customer.id,null,{reservationId:created.freeReservation.id});
      subscriptionId=sub?.id||null;
    }catch(error){
      const row=(await query(`SELECT id FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND source='free_claim' ORDER BY created_at DESC LIMIT 1`,[created.customer.id,free.id])).rows[0];
      if(!row)throw error;
      subscriptionId=row.id;
    }
    assert(subscriptionId,'validated reservation did not convert into Free Access');
    const converted=(await query(`SELECT consumed_at,customer_id,subscription_id FROM free_access_registration_reservations WHERE id=$1`,[first.freeReservation.id])).rows[0];
    assert(converted?.consumed_at,'converted reservation was not marked consumed');
    assert.equal(String(converted.customer_id),String(created.customer.id),'reservation did not record the customer');
    assert.equal(String(converted.subscription_id),String(subscriptionId),'reservation did not record the resulting subscription');

    const after=await capacity.usage(free.id);
    assert.equal(after.reservedUsers,0,'converted reservation still consumes reservation capacity');
    assert(after.userUsed>=81,'converted reservation did not become one owed/managed customer place');

    const permanent=(await query(`SELECT current_period_end FROM subscriptions WHERE id=$1`,[subscriptionId])).rows[0];
    assert(new Date(permanent.current_period_end).getUTCFullYear()===9999,'Free subscription is not persisted as non-expiring');

    const retryState=(await query(`SELECT status,next_attempt_at FROM customer_provisioning_state WHERE customer_id=$1`,[created.customer.id])).rows[0];
    assert(retryState&&['failed','blocked','pending'].includes(String(retryState.status)),'remote Jellyfin failure did not persist a retryable provisioning state');
    await query(`UPDATE customer_provisioning_state SET next_attempt_at=NOW()-INTERVAL '1 second',updated_at=NOW() WHERE customer_id=$1`,[created.customer.id]);
    delete require.cache[require.resolve('../src/jellyfin/jobs')];
    const restartedJobs=require('../src/jellyfin/jobs');
    const dueAfterRestart=await restartedJobs.dueCustomers(1000);
    assert(dueAfterRestart.some(row=>String(row.customer_id)===String(created.customer.id)),'persisted failed provisioning was not rediscovered after a worker/module restart');

    // Verification-time identity races remain terminal and must release the
    // real reservation, rather than leaving a capacity leak behind.
    const terminalBaseline=await capacity.usage(free.id);
    await query(`UPDATE jellyfin_servers SET max_users=$2,updated_at=NOW() WHERE id=$1`,[serverId,Number(terminalBaseline.userUsed||0)+1]);
    const terminalSession=`${tag}:terminal`;
    const terminalIntent=await pending.reserveFreeAccess({sessionId:terminalSession});
    intentIds.push(terminalIntent.id);
    terminal=await pending.begin({
      email:`${tag}-terminal@example.test`,
      username:`terminal_${crypto.randomBytes(8).toString('hex')}`.slice(0,40),
      password:'ReservationSmoke!2026',
      freeAccess:true,
      ttlMinutes:60,
      freeReservationId:terminalIntent.id,
      freeReservationSessionId:terminalSession
    });
    pendingIds.push(terminal.id);reservationIds.push(terminal.freeReservation.id);
    const terminalHeld=await capacity.usage(free.id);
    assert.equal(terminalHeld.remaining,0,'terminal-race reservation did not take the final available place');

    const sourceHash=(await query(`SELECT password_hash FROM app_users WHERE id=$1`,[created.user.id])).rows[0]?.password_hash;
    duplicateUserId=(await query(`INSERT INTO app_users(email,username,password_hash,role,email_verified_at) VALUES($1,$2,$3,'customer',NOW()) RETURNING id`,[terminal.email,`${tag}-dup`.slice(0,40),sourceHash])).rows[0].id;

    let terminalRejected=false;
    try{await pending.consume(terminal.token);}catch(error){terminalRejected=/already exists/i.test(error.message);}
    assert(terminalRejected,'identity race did not reject the pending registration');
    const terminalRow=(await query(`SELECT consumed_at FROM pending_registrations WHERE id=$1`,[terminal.id])).rows[0];
    assert(terminalRow?.consumed_at,'terminal pending registration remained reusable after rejection');
    const releasedReservation=(await query(`SELECT consumed_at,released_at FROM free_access_registration_reservations WHERE id=$1`,[terminal.freeReservation.id])).rows[0];
    assert(!releasedReservation?.consumed_at,'terminal reservation was incorrectly consumed');
    assert(releasedReservation?.released_at,'terminal reservation was not released');
    const afterRelease=await capacity.usage(free.id);
    assert(afterRelease.remaining>=1,'terminal rejection did not return its reserved place');

    await recoverySmoke.run();
    console.log('Free Access intent/capacity/verification DB smoke: ok');
  }finally{
    for(const id of reservationIds)await query(`DELETE FROM free_access_registration_reservations WHERE id=$1`,[id]).catch(()=>{});
    for(const id of intentIds)await query(`DELETE FROM free_access_registration_intents WHERE id=$1`,[id]).catch(()=>{});
    for(const id of pendingIds)await query(`DELETE FROM pending_registrations WHERE id=$1`,[id]).catch(()=>{});
    if(subscriptionId)await query(`DELETE FROM subscriptions WHERE id=$1`,[subscriptionId]).catch(()=>{});
    if(created?.customer?.id)await query(`DELETE FROM customers WHERE id=$1`,[created.customer.id]).catch(()=>{});
    if(created?.user?.id)await query(`DELETE FROM app_users WHERE id=$1`,[created.user.id]).catch(()=>{});
    if(duplicateUserId)await query(`DELETE FROM app_users WHERE id=$1`,[duplicateUserId]).catch(()=>{});
    await query(`DELETE FROM pending_registrations WHERE email LIKE $1`,[`%${tag}%`]).catch(()=>{});
    await query(`DELETE FROM free_access_registration_intents WHERE created_at>NOW()-INTERVAL '2 hours' AND holder_session_hash IS NOT NULL AND plan_id=$1`,[free.id]).catch(()=>{});
    await query(`DELETE FROM jellyfin_accounts WHERE server_id=$1 AND jellyfin_user_id LIKE 'capacity-%'`,[serverId]).catch(()=>{});
    await query(`DELETE FROM customers WHERE email LIKE $1`,[`${tag}-capacity-%@example.test`]).catch(()=>{});
    if(serverId){
      await query(`DELETE FROM jellyfin_account_creation_intents WHERE server_id=$1`,[serverId]).catch(()=>{});
      await query(`DELETE FROM jellyfin_accounts WHERE server_id=$1`,[serverId]).catch(()=>{});
      await query(`DELETE FROM plan_server_eligibility WHERE plan_id=$1 AND server_id=$2`,[free.id,serverId]).catch(()=>{});
      await query(`DELETE FROM jellyfin_servers WHERE id=$1`,[serverId]).catch(()=>{});
    }
    await query(`UPDATE plans SET capacity_limit=$2,updated_at=NOW() WHERE id=$1`,[free.id,originalLimit]).catch(()=>{});
  }
}

main().then(()=>process.exit(0)).catch(error=>{console.error(error.stack||error);process.exit(1);});
