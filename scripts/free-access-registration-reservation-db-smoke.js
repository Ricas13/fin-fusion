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
  assert.equal(pending.FREE_HOLD_MINUTES,10,'Free Access hold must be exactly 10 minutes');
  const originalLimit=free.capacity_limit;
  const tag=`hold-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const reservationIds=[];
  let first=null,created=null,subscriptionId=null,terminal=null,duplicateUserId=null,serverId=null;
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

    // Release-critical scenario: the production Free server is 80/80, an
    // administrator raises max_users to 90, and the same running process must
    // expose exactly ten places without a restart or a second plan capacity.
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
    assert.equal(at80.limit,80,'server max_users=80 was not the authoritative Free capacity');
    assert.equal(at80.remaining,0,'80/80 Free server was not sold out');

    await query(`UPDATE jellyfin_servers SET max_users=90,updated_at=NOW() WHERE id=$1`,[serverId]);
    const at90=await capacity.usage(free.id);
    assert.equal(at90.userUsed,80,'raising the limit changed the managed-user count');
    assert.equal(at90.limit,90,'server max_users=90 was not picked up immediately');
    assert.equal(at90.remaining,10,'80/90 did not expose exactly ten Free places without restart');

    const burst=await Promise.allSettled(Array.from({length:11},(_,index)=>
      pending.reserveFreeAccess({sessionId:`${tag}:burst-${index+1}`})
    ));
    const accepted=burst.filter(result=>result.status==='fulfilled').map(result=>result.value);
    const rejected=burst.filter(result=>result.status==='rejected');
    assert.equal(accepted.length,10,'concurrent Free reservations did not consume exactly the ten newly opened places');
    assert.equal(rejected.length,1,'the 11th concurrent Free reservation was not rejected');
    assert.equal(rejected[0].reason?.message,'No free places currently available','the 11th reservation returned the wrong sold-out response');
    for(const hold of accepted)reservationIds.push(hold.id);
    const burstFull=await capacity.usage(free.id);
    assert.equal(burstFull.reservedUsers,10,'ten concurrent reservations did not count as ten customer places');
    assert.equal(burstFull.remaining,0,'the 11-request burst oversubscribed the 80/90 Free server');

    await query(`
      UPDATE free_access_registration_reservations
      SET released_at=NOW(),updated_at=NOW()
      WHERE id=ANY($1::uuid[])
    `,[accepted.map(hold=>hold.id)]);
    const burstReleased=await capacity.usage(free.id);
    assert.equal(burstReleased.remaining,10,'released concurrent reservations did not immediately return all ten places');

    await query(`DELETE FROM jellyfin_accounts WHERE server_id=$1 AND jellyfin_user_id LIKE 'capacity-%'`,[serverId]);
    await query(`DELETE FROM customers WHERE email LIKE $1`,[`${tag}-capacity-%@example.test`]);

    const before=await capacity.usage(free.id);
    const temporaryLimit=Number(before.userUsed||0)+Number(before.reservedUsers||0)+1;
    await query(`UPDATE jellyfin_servers SET max_users=$2,updated_at=NOW() WHERE id=$1`,[serverId,temporaryLimit]);

    const firstSession=`${tag}:session-a`;
    const firstHold=await pending.reserveFreeAccess({sessionId:firstSession});
    reservationIds.push(firstHold.id);
    assert(firstHold?.id,'explicit Free Access reservation did not create a hold');
    const holdMs=new Date(firstHold.expires_at).getTime()-Date.now();
    assert(holdMs>9*60000&&holdMs<=10*60000+5000,'Free Access reservation does not expire in the 10-minute window');

    const idempotent=await pending.reserveFreeAccess({sessionId:firstSession});
    assert.equal(String(idempotent.id),String(firstHold.id),'same browser session created a second Free Access hold');
    const held=await capacity.usage(free.id);
    assert.equal(held.reservedUsers,Number(before.reservedUsers||0)+1,'reservation was not counted as one customer place');
    assert.equal(held.remaining,0,'last available Free Access customer place was not held immediately');

    let blockedMessage='';
    try{await pending.reserveFreeAccess({sessionId:`${tag}:session-b`});}
    catch(error){blockedMessage=error.message;}
    assert.equal(blockedMessage,'No free places currently available','second browser did not receive the canonical no-capacity response');

    let unreservedRejected=false;
    try{await pending.begin({email:`${tag}-unreserved@example.test`,username:`${tag}-unreserved`.slice(0,40),password:'ReservationSmoke!2026',freeAccess:true,ttlMinutes:60,freeReservationSessionId:`${tag}:no-hold`});}
    catch(error){unreservedRejected=/reservation has expired/i.test(error.message);}
    assert(unreservedRejected,'Free Access registration could start without an explicit reservation');

    first=await pending.begin({email:`${tag}-a@example.test`,username:`${tag}-a`.slice(0,40),password:'ReservationSmoke!2026',freeAccess:true,ttlMinutes:60,freeReservationId:firstHold.id,freeReservationSessionId:firstSession});
    assert.equal(String(first.freeReservation?.id),String(firstHold.id),'registration did not attach the pre-existing hold');
    assert.equal(new Date(first.freeReservation.expires_at).getTime(),new Date(firstHold.expires_at).getTime(),'registration incorrectly extended the original hold');

    created=await pending.consume(first.token);
    assert(created?.freeAccessRequested,'verified registration lost Free Access intent');
    assert.equal(String(created.freeReservation?.id),String(firstHold.id),'verified registration did not retain its reservation');

    try{const sub=await lifecycle.claimFreePlan(created.customer.id,null,{reservationId:created.freeReservation.id});subscriptionId=sub?.id||null;}
    catch(error){
      const row=(await query(`SELECT id FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND source='free_claim' ORDER BY created_at DESC LIMIT 1`,[created.customer.id,free.id])).rows[0];
      if(!row)throw error;
      subscriptionId=row.id;
    }
    assert(subscriptionId,'reservation did not convert into Free Access');
    const converted=(await query(`SELECT consumed_at,customer_id,subscription_id FROM free_access_registration_reservations WHERE id=$1`,[firstHold.id])).rows[0];
    assert(converted?.consumed_at,'converted reservation was not marked consumed');
    assert.equal(String(converted.customer_id),String(created.customer.id),'reservation did not record the customer');
    assert.equal(String(converted.subscription_id),String(subscriptionId),'reservation did not record the resulting subscription');
    const after=await capacity.usage(free.id);
    assert.equal(after.reservedUsers,Number(before.reservedUsers||0),'converted hold still consumes reservation capacity');
    assert(after.userUsed>=Number(before.userUsed||0)+1,'converted hold did not become one owed/managed customer place');

    const permanent=(await query(`SELECT current_period_end FROM subscriptions WHERE id=$1`,[subscriptionId])).rows[0];
    assert(new Date(permanent.current_period_end).getUTCFullYear()===9999,'Free subscription is not persisted as non-expiring');

    const retryState=(await query(`SELECT status,next_attempt_at FROM customer_provisioning_state WHERE customer_id=$1`,[created.customer.id])).rows[0];
    assert(retryState&&['failed','blocked','pending'].includes(String(retryState.status)),'remote Jellyfin failure did not persist a retryable provisioning state');
    await query(`UPDATE customer_provisioning_state SET next_attempt_at=NOW()-INTERVAL '1 second',updated_at=NOW() WHERE customer_id=$1`,[created.customer.id]);
    delete require.cache[require.resolve('../src/jellyfin/jobs')];
    const restartedJobs=require('../src/jellyfin/jobs');
    const dueAfterRestart=await restartedJobs.dueCustomers(1000);
    assert(dueAfterRestart.some(row=>String(row.customer_id)===String(created.customer.id)),'persisted failed provisioning was not rediscovered after a worker/module restart');

    const terminalLimit=Number(after.userUsed||0)+Number(after.reservedUsers||0)+1;
    await query(`UPDATE jellyfin_servers SET max_users=$2,updated_at=NOW() WHERE id=$1`,[serverId,terminalLimit]);
    const terminalSession=`${tag}:terminal`;
    const terminalHold=await pending.reserveFreeAccess({sessionId:terminalSession});
    reservationIds.push(terminalHold.id);
    terminal=await pending.begin({email:`${tag}-terminal@example.test`,username:`${tag}-terminal`.slice(0,40),password:'ReservationSmoke!2026',freeAccess:true,ttlMinutes:60,freeReservationId:terminalHold.id,freeReservationSessionId:terminalSession});
    assert.equal(String(terminal.freeReservation?.id),String(terminalHold.id),'terminal registration did not retain its pre-hold');
    const terminalHeld=await capacity.usage(free.id);
    assert.equal(terminalHeld.reservedUsers,Number(after.reservedUsers||0)+1,'terminal registration reservation was not counted as one place');

    const sourceHash=(await query(`SELECT password_hash FROM app_users WHERE id=$1`,[created.user.id])).rows[0]?.password_hash;
    assert(sourceHash,'source password hash missing');
    duplicateUserId=(await query(`INSERT INTO app_users(email,username,password_hash,role,email_verified_at) VALUES($1,$2,$3,'customer',NOW()) RETURNING id`,[terminal.email,`${tag}-dup`.slice(0,40),sourceHash])).rows[0].id;

    let terminalRejected=false;
    try{await pending.consume(terminal.token);}
    catch(error){terminalRejected=/already exists/i.test(error.message);}
    assert(terminalRejected,'identity race did not reject the pending registration');

    const terminalRow=(await query(`SELECT consumed_at FROM pending_registrations WHERE id=$1`,[terminal.id])).rows[0];
    assert(terminalRow?.consumed_at,'terminal pending registration remained reusable after rejection');
    const releasedReservation=(await query(`SELECT consumed_at,released_at FROM free_access_registration_reservations WHERE id=$1`,[terminalHold.id])).rows[0];
    assert(!releasedReservation?.consumed_at,'terminal reservation was incorrectly consumed');
    assert(releasedReservation?.released_at,'terminal reservation was not released');
    const afterRelease=await capacity.usage(free.id);
    assert.equal(afterRelease.reservedUsers,Number(after.reservedUsers||0),'terminal rejection continued to consume a customer place');

    const expiryLimit=Number(afterRelease.userUsed||0)+Number(afterRelease.reservedUsers||0)+1;
    await query(`UPDATE jellyfin_servers SET max_users=$2,updated_at=NOW() WHERE id=$1`,[serverId,expiryLimit]);
    const expiringHold=await pending.reserveFreeAccess({sessionId:`${tag}:expiry-a`});
    reservationIds.push(expiringHold.id);
    await query(`UPDATE free_access_registration_reservations SET expires_at=NOW()-INTERVAL '1 second',updated_at=NOW() WHERE id=$1`,[expiringHold.id]);
    const afterExpiry=await capacity.usage(free.id);
    assert.equal(afterExpiry.reservedUsers,Number(afterRelease.reservedUsers||0),'expired hold still consumed a customer place');
    const replacementHold=await pending.reserveFreeAccess({sessionId:`${tag}:expiry-b`});
    reservationIds.push(replacementHold.id);
    assert(replacementHold?.id,'expired customer place was not immediately reservable by another browser');

    await recoverySmoke.run();
    console.log('Free Access 80-to-90 registration/provisioning DB smoke: ok');
  } finally {
    for(const id of reservationIds)await query(`DELETE FROM free_access_registration_reservations WHERE id=$1`,[id]).catch(()=>{});
    if(subscriptionId)await query(`DELETE FROM subscriptions WHERE id=$1`,[subscriptionId]).catch(()=>{});
    if(terminal?.id)await query(`DELETE FROM pending_registrations WHERE id=$1`,[terminal.id]).catch(()=>{});
    if(first?.id)await query(`DELETE FROM pending_registrations WHERE id=$1`,[first.id]).catch(()=>{});
    if(created?.customer?.id)await query(`DELETE FROM customers WHERE id=$1`,[created.customer.id]).catch(()=>{});
    if(created?.user?.id)await query(`DELETE FROM app_users WHERE id=$1`,[created.user.id]).catch(()=>{});
    if(duplicateUserId)await query(`DELETE FROM app_users WHERE id=$1`,[duplicateUserId]).catch(()=>{});
    await query(`DELETE FROM pending_registrations WHERE email LIKE $1`,[`%${tag}%`]).catch(()=>{});
    await query(`DELETE FROM jellyfin_accounts WHERE jellyfin_user_id LIKE 'capacity-%'`).catch(()=>{});
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