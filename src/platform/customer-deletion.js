'use strict';

const {query,transaction}=require('../db');
const registry=require('../jellyfin/registry');
const provisioning=require('../jellyfin/provisioning');

function message(error){return String(error?.message||error||'Unknown error').slice(0,1000);}
function isRemoteMissing(error){const value=message(error);return Number(error?.status)===404||/\b404\b|not found|not\s+exist/i.test(value);}

async function deleteJellyfinAccounts(customerId,{actorUserId=null,reason='Deleted by administrator',holdAccess=true,removeLocal=true,continueOnMissing=true}={}){
  if(holdAccess)await provisioning.holdAccess(customerId,'jellyfin_deleted',actorUserId);
  const accounts=await query(`SELECT id,server_id,jellyfin_user_id,jellyfin_username FROM jellyfin_accounts WHERE customer_id=$1 ORDER BY created_at`,[customerId]);
  const results=[];
  for(const account of accounts.rows){
    const label=account.jellyfin_username||account.jellyfin_user_id||String(account.id);
    try{
      if(!account.jellyfin_user_id)throw new Error(`Local Jellyfin account ${label} has no Jellyfin user id.`);
      await registry.request(account.server_id,`/Users/${encodeURIComponent(account.jellyfin_user_id)}`,{method:'DELETE',timeoutMs:15000});
      if(removeLocal)await query('DELETE FROM jellyfin_accounts WHERE id=$1',[account.id]);
      results.push({accountId:account.id,username:label,status:'deleted'});
    }catch(error){
      if(continueOnMissing&&isRemoteMissing(error)){
        if(removeLocal)await query('DELETE FROM jellyfin_accounts WHERE id=$1',[account.id]);
        results.push({accountId:account.id,username:label,status:'already_missing'});
        continue;
      }
      results.push({accountId:account.id,username:label,status:'failed',error:message(error)});
    }
  }
  const failed=results.filter(row=>row.status==='failed');
  if(failed.length){
    const first=failed[0];
    throw new Error(`Could not delete ${first.username} from Jellyfin: ${first.error}`);
  }
  return{total:accounts.rows.length,deleted:results.filter(row=>row.status==='deleted').length,alreadyMissing:results.filter(row=>row.status==='already_missing').length,reason,results};
}

async function hardDeletePortalCustomer(customerId,{actorUserId=null,reason='Portal customer deleted by administrator'}={}){
  const customer=await query(`SELECT c.id,c.user_id,COALESCE(c.display_name,u.username,c.email,u.email,'Customer') AS name,COALESCE(c.email,u.email) AS email FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[customerId]);
  if(!customer.rowCount)throw new Error('Customer not found.');
  const row=customer.rows[0];
  const jellyfin=await deleteJellyfinAccounts(customerId,{actorUserId,reason,holdAccess:true,removeLocal:true,continueOnMissing:true});
  await transaction(async client=>{
    await client.query('DELETE FROM content_requests WHERE customer_id=$1',[customerId]);
    await client.query('DELETE FROM customer_bans WHERE customer_id=$1 OR ($2::text IS NOT NULL AND normalized_email=LOWER(BTRIM($2::text)))',[customerId,row.email||null]);
    await client.query('DELETE FROM customer_download_events WHERE customer_id=$1',[customerId]);
    await client.query('DELETE FROM free_access_registration_reservations WHERE customer_id=$1',[customerId]);
    await client.query('DELETE FROM payment_incidents WHERE customer_id=$1',[customerId]);
    await client.query('DELETE FROM playback_history WHERE customer_id=$1',[customerId]);
    await client.query('DELETE FROM stream_policy_events WHERE customer_id=$1',[customerId]);
    await client.query('DELETE FROM affiliate_credit_ledger WHERE referred_customer_id=$1',[customerId]);
    await client.query('DELETE FROM audit_log WHERE entity_type=$1 AND entity_id=$2',['customer',String(customerId)]);
    await client.query('DELETE FROM customers WHERE id=$1',[customerId]);
    if(row.user_id){
      await client.query('DELETE FROM auth_events WHERE user_id=$1',[row.user_id]);
      await client.query(`DELETE FROM app_users WHERE id=$1 AND role='customer' AND NOT EXISTS(SELECT 1 FROM customers WHERE user_id=$1)`,[row.user_id]);
    }
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.hard_delete','customer_deleted',$2,$3::jsonb)`,[actorUserId,String(customerId),JSON.stringify({reason,jellyfin:{total:jellyfin.total,deleted:jellyfin.deleted,alreadyMissing:jellyfin.alreadyMissing}})]);
  });
  return{customerId,name:row.name,email:row.email,jellyfin,deleted:true};
}

module.exports={deleteJellyfinAccounts,hardDeletePortalCustomer};
