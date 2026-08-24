'use strict';

const assert=require('assert');
const crypto=require('crypto');
const {query}=require('../src/db');
const pending=require('../src/security/pending-registration');
const capacity=require('../src/entitlements/plan-capacity');
const lifecycle=require('../src/payments/lifecycle');

async function main(){
  const free=(await query(`SELECT id,code,capacity_limit FROM plans WHERE is_free_tier=TRUE LIMIT 1`)).rows[0];
  assert(free,'canonical Free Access plan is missing');
  const originalLimit=free.capacity_limit;
  const tag=`hold-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  let first=null,created=null,subscriptionId=null,terminal=null,duplicateUserId=null;
  try{
    const before=await capacity.usage(free.id);
    const temporaryLimit=Number(before.used||0)+Number(before.reserved||0)+1;
    await query(`UPDATE plans SET capacity_limit=$2,updated_at=NOW() WHERE id=$1`,[free.id,temporaryLimit]);

    first=await pending.begin({email:`${tag}-a@example.test`,username:`${tag}-a`.slice(0,40),password:'ReservationSmoke!2026',freeAccess:true,ttlMinutes:60});
    assert(first.freeReservation?.id,'limited Free Access registration did not create a reservation');
    const held=await capacity.usage(free.id);
    assert.equal(held.reserved,Number(before.reserved||0)+1,'reservation was not counted against plan capacity');
    assert.equal(held.remaining,0,'last available Free Access place was not held');

    let blocked=false;
    try{await pending.begin({email:`${tag}-b@example.test`,username:`${tag}-b`.slice(0,40),password:'ReservationSmoke!2026',freeAccess:true,ttlMinutes:60});}
    catch(error){blocked=/sold out/i.test(error.message);}
    assert(blocked,'a second registration was able to reserve the already-held final Free Access place');

    created=await pending.consume(first.token);
    assert(created?.freeAccessRequested,'verified registration lost Free Access intent');
    assert.equal(String(created.freeReservation?.id),String(first.freeReservation.id),'verified registration did not retain its reservation');

    try{const sub=await lifecycle.claimFreePlan(created.customer.id,null,{reservationId:created.freeReservation.id});subscriptionId=sub?.id||null;}
    catch(error){
      const row=(await query(`SELECT id FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND source='free_claim' ORDER BY created_at DESC LIMIT 1`,[created.customer.id,free.id])).rows[0];
      if(!row)throw error;
      subscriptionId=row.id;
    }
    assert(subscriptionId,'reservation did not convert into Free Access');
    const converted=(await query(`SELECT consumed_at,customer_id,subscription_id FROM free_access_registration_reservations WHERE id=$1`,[created.freeReservation.id])).rows[0];
    assert(converted?.consumed_at,'converted reservation was not marked consumed');
    assert.equal(String(converted.customer_id),String(created.customer.id),'reservation did not record the customer');
    assert.equal(String(converted.subscription_id),String(subscriptionId),'reservation did not record the resulting subscription');
    const after=await capacity.usage(free.id);
    assert.equal(after.reserved,Number(before.reserved||0),'converted hold still consumes reservation capacity');
    assert(after.used>=Number(before.used||0)+1,'converted hold did not become a live subscription');

    const terminalLimit=Number(after.used||0)+Number(after.reserved||0)+1;
    await query(`UPDATE plans SET capacity_limit=$2,updated_at=NOW() WHERE id=$1`,[free.id,terminalLimit]);
    terminal=await pending.begin({email:`${tag}-terminal@example.test`,username:`${tag}-terminal`.slice(0,40),password:'ReservationSmoke!2026',freeAccess:true,ttlMinutes:60});
    assert(terminal.freeReservation?.id,'terminal registration did not create a reservation');
    const terminalHeld=await capacity.usage(free.id);
    assert.equal(terminalHeld.reserved,Number(after.reserved||0)+1,'terminal registration reservation was not counted');

    const sourceHash=(await query(`SELECT password_hash FROM app_users WHERE id=$1`,[created.user.id])).rows[0]?.password_hash;
    assert(sourceHash,'source password hash missing');
    duplicateUserId=(await query(`INSERT INTO app_users(email,username,password_hash,role,email_verified_at) VALUES($1,$2,$3,'customer',NOW()) RETURNING id`,[terminal.email,`${tag}-dup`.slice(0,40),sourceHash])).rows[0].id;

    let terminalRejected=false;
    try{await pending.consume(terminal.token);}
    catch(error){terminalRejected=/already exists/i.test(error.message);}
    assert(terminalRejected,'identity race did not reject the pending registration');

    const terminalRow=(await query(`SELECT consumed_at FROM pending_registrations WHERE id=$1`,[terminal.id])).rows[0];
    assert(terminalRow?.consumed_at,'terminal pending registration remained reusable after rejection');
    const releasedReservation=(await query(`SELECT consumed_at,released_at FROM free_access_registration_reservations WHERE id=$1`,[terminal.freeReservation.id])).rows[0];
    assert(!releasedReservation?.consumed_at,'terminal reservation was incorrectly consumed');
    assert(releasedReservation?.released_at,'terminal reservation was not released');
    const afterRelease=await capacity.usage(free.id);
    assert.equal(afterRelease.reserved,Number(after.reserved||0),'terminal rejection continued to consume Free Access capacity');

    console.log('Free Access registration reservation DB smoke: ok');
  } finally {
    if(subscriptionId)await query(`DELETE FROM subscriptions WHERE id=$1`,[subscriptionId]).catch(()=>{});
    if(terminal?.id)await query(`DELETE FROM pending_registrations WHERE id=$1`,[terminal.id]).catch(()=>{});
    if(first?.id)await query(`DELETE FROM pending_registrations WHERE id=$1`,[first.id]).catch(()=>{});
    if(created?.customer?.id)await query(`DELETE FROM customers WHERE id=$1`,[created.customer.id]).catch(()=>{});
    if(created?.user?.id)await query(`DELETE FROM app_users WHERE id=$1`,[created.user.id]).catch(()=>{});
    if(duplicateUserId)await query(`DELETE FROM app_users WHERE id=$1`,[duplicateUserId]).catch(()=>{});
    await query(`UPDATE plans SET capacity_limit=$2,updated_at=NOW() WHERE id=$1`,[free.id,originalLimit]).catch(()=>{});
  }
}

main().then(()=>process.exit(0)).catch(error=>{console.error(error.stack||error);process.exit(1);});
