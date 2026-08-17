'use strict';

const {query,transaction}=require('../db');
const monthly=require('./monthly');
const accessHolds=require('../entitlements/access-holds');
const provisioning=require('../jellyfin/provisioning');
const registry=require('../jellyfin/registry');

const MANUAL_HOLD='reseller_manual';

function cleanUsername(value){
  const username=String(value||'').trim();
  if(!/^[A-Za-z0-9._-]{3,40}$/.test(username))throw new Error('Username must be 3–40 characters using letters, numbers, dot, underscore or dash.');
  return username;
}

async function seatUsage(resellerId,client=null){
  const db=client||{query};
  const result=await db.query(`
    SELECT COUNT(*)::int used
    FROM customers
    WHERE reseller_id=$1 AND reseller_managed=TRUE
  `,[resellerId]);
  return Number(result.rows[0]?.used||0);
}

async function entitlement(resellerId,client=null){
  const state=await monthly.resellerEntitlement(resellerId,client);
  if(!state.active)throw new Error('Your reseller subscription is not active. Renew it before managing Jellyfin users.');
  return state.row;
}

async function assertSeatAvailable(client,resellerId){
  const lock=await client.query('SELECT id FROM resellers WHERE id=$1 FOR UPDATE',[resellerId]);
  if(!lock.rowCount)throw new Error('Reseller not found.');
  const tier=await entitlement(resellerId,client);
  const used=await seatUsage(resellerId,client),limit=Number(tier.seat_limit||0);
  if(used>=limit)throw new Error(`Your ${tier.tier_name} plan is full (${used}/${limit} managed Jellyfin users). Delete an unused user or upgrade the reseller plan.`);
  return{tier,used,limit};
}

async function createManagedUser({resellerId,username,actorUserId=null}){
  username=cleanUsername(username);
  const saved=await transaction(async client=>{
    const capacity=await assertSeatAvailable(client,resellerId);
    const duplicate=await client.query(`SELECT 1 FROM customers WHERE reseller_id=$1 AND reseller_managed=TRUE AND lower(display_name)=lower($2) LIMIT 1`,[resellerId,username]);
    if(duplicate.rowCount)throw new Error('That managed username already exists in your reseller account.');
    const customer=(await client.query(`INSERT INTO customers(reseller_id,display_name,reseller_managed,note) VALUES($1,$2,TRUE,'Managed by reseller') RETURNING *`,[resellerId,username])).rows[0];
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'reseller.managed_user.create','customer',$2,$3::jsonb)`,[actorUserId,customer.id,JSON.stringify({resellerId,username,seatLimit:capacity.limit,seatNumber:capacity.used+1})]);
    return{customer,capacity};
  });
  try{
    const reconcile=await provisioning.reconcileCustomer(saved.customer.id);
    return{...saved,reconcile};
  }catch(error){
    const account=await query('SELECT 1 FROM jellyfin_accounts WHERE customer_id=$1 LIMIT 1',[saved.customer.id]);
    if(!account.rowCount)await query('DELETE FROM customers WHERE id=$1 AND reseller_managed=TRUE',[saved.customer.id]).catch(()=>{});
    throw error;
  }
}

async function listManagedUsers(resellerId){
  const result=await query(`
    SELECT c.id,c.display_name,c.created_at,c.access_paused_at,
           ja.id jellyfin_account_id,ja.jellyfin_username,ja.disabled,ja.last_policy_sync,
           js.id server_id,js.name server_name,js.public_url,
           COUNT(DISTINCT aps.jellyfin_session_id)::int active_streams,
           EXISTS(
             SELECT 1 FROM customer_access_holds h
             WHERE h.customer_id=c.id AND h.hold_type=$2 AND h.source_key=$1::text AND h.released_at IS NULL
           ) manually_suspended
    FROM customers c
    LEFT JOIN LATERAL(
      SELECT * FROM jellyfin_accounts
      WHERE customer_id=c.id AND account_purpose<>'stremio_internal'
      ORDER BY is_primary DESC,created_at ASC LIMIT 1
    ) ja ON TRUE
    LEFT JOIN jellyfin_servers js ON js.id=ja.server_id
    LEFT JOIN active_playback_sessions aps ON aps.customer_id=c.id
    WHERE c.reseller_id=$1 AND c.reseller_managed=TRUE
    GROUP BY c.id,ja.id,js.id
    ORDER BY c.created_at DESC
  `,[resellerId,MANUAL_HOLD]);
  return result.rows;
}

async function getManagedUser(resellerId,customerId){
  const result=await query(`SELECT * FROM customers WHERE id=$1 AND reseller_id=$2 AND reseller_managed=TRUE`,[customerId,resellerId]);
  return result.rows[0]||null;
}

async function setSuspended({resellerId,customerId,suspended,actorUserId=null}){
  const customer=await getManagedUser(resellerId,customerId);
  if(!customer)throw new Error('Managed Jellyfin user not found.');
  if(suspended){
    await accessHolds.addHold({customerId,type:MANUAL_HOLD,sourceKey:resellerId,reason:'Suspended by reseller',actorUserId,metadata:{resellerId}});
  }else{
    await entitlement(resellerId);
    await accessHolds.releaseHold({customerId,type:MANUAL_HOLD,sourceKey:resellerId,actorUserId});
  }
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,suspended?'reseller.managed_user.suspend':'reseller.managed_user.resume',customerId,JSON.stringify({resellerId,seatReleased:false})]);
  return provisioning.reconcileCustomer(customerId);
}

async function deleteManagedUser({resellerId,customerId,actorUserId=null}){
  const customer=await getManagedUser(resellerId,customerId);
  if(!customer)throw new Error('Managed Jellyfin user not found.');
  const accounts=await query(`SELECT id,server_id,jellyfin_user_id,jellyfin_username FROM jellyfin_accounts WHERE customer_id=$1 AND account_purpose<>'stremio_internal'`,[customerId]);
  for(const account of accounts.rows){
    await registry.request(account.server_id,`/Users/${encodeURIComponent(account.jellyfin_user_id)}`,{method:'DELETE'});
  }
  await transaction(async client=>{
    const removed=await client.query('DELETE FROM customers WHERE id=$1 AND reseller_id=$2 AND reseller_managed=TRUE RETURNING display_name',[customerId,resellerId]);
    if(!removed.rowCount)throw new Error('Managed Jellyfin user was already removed.');
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'reseller.managed_user.delete','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({resellerId,username:removed.rows[0].display_name,remoteAccountsDeleted:accounts.rowCount,seatReleased:true})]);
  });
  return{deleted:true,seatUsage:await seatUsage(resellerId)};
}

module.exports={MANUAL_HOLD,cleanUsername,seatUsage,entitlement,assertSeatAvailable,createManagedUser,listManagedUsers,getManagedUser,setSuspended,deleteManagedUser};
