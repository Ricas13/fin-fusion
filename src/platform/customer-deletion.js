'use strict';

const {query,transaction}=require('../db');
const registry=require('../jellyfin/registry');
const provisioning=require('../jellyfin/provisioning');

const RUNNING_STALE_MINUTES=15;
const RETRY_MINUTES=[1,5,15,60,180,360];

function message(error){return String(error?.message||error||'Unknown error').slice(0,1000);}
function isRemoteMissing(error){const value=message(error);return Number(error?.status)===404||/\b404\b|not found|not\s+exist/i.test(value);}
function retryMinutes(attempt){const n=Math.max(1,Number(attempt)||1);return RETRY_MINUTES[Math.min(n-1,RETRY_MINUTES.length-1)];}
function pendingError(job,error){const out=new Error(`Customer deletion is pending and will retry automatically: ${message(error)}`);out.code='CUSTOMER_DELETION_PENDING';out.jobId=job?.id||null;out.cause=error;return out;}

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
      results.push({accountId:account.id,serverId:account.server_id,jellyfinUserId:account.jellyfin_user_id,username:label,status:'deleted'});
    }catch(error){
      if(continueOnMissing&&isRemoteMissing(error)){
        if(removeLocal)await query('DELETE FROM jellyfin_accounts WHERE id=$1',[account.id]);
        results.push({accountId:account.id,serverId:account.server_id,jellyfinUserId:account.jellyfin_user_id,username:label,status:'already_missing'});
        continue;
      }
      results.push({accountId:account.id,serverId:account.server_id,jellyfinUserId:account.jellyfin_user_id,username:label,status:'failed',error:message(error)});
    }
  }
  const failed=results.filter(row=>row.status==='failed');
  if(failed.length){
    const first=failed[0];
    const error=new Error(`Could not delete ${first.username} from Jellyfin: ${first.error}`);
    error.deletionResults=results;
    throw error;
  }
  return{total:accounts.rows.length,deleted:results.filter(row=>row.status==='deleted').length,alreadyMissing:results.filter(row=>row.status==='already_missing').length,reason,results};
}

async function customerSnapshot(customerId){
  const customer=await query(`SELECT c.id,c.user_id,COALESCE(c.display_name,u.username,c.email,u.email,'Customer') AS name,COALESCE(c.email,u.email) AS email FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[customerId]);
  if(!customer.rowCount)throw new Error('Customer not found.');
  return customer.rows[0];
}

async function enqueueHardDelete(customerId,{actorUserId=null,reason='Portal customer deleted by administrator'}={}){
  const row=await customerSnapshot(customerId);
  const created=await query(`
    INSERT INTO customer_deletion_jobs(customer_id,user_id,customer_name,customer_email,actor_user_id,reason,status,next_attempt_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'pending',NOW(),NOW())
    ON CONFLICT (customer_id) WHERE status IN ('pending','running','failed')
    DO UPDATE SET
      actor_user_id=COALESCE(EXCLUDED.actor_user_id,customer_deletion_jobs.actor_user_id),
      reason=EXCLUDED.reason,
      customer_name=COALESCE(customer_deletion_jobs.customer_name,EXCLUDED.customer_name),
      customer_email=COALESCE(customer_deletion_jobs.customer_email,EXCLUDED.customer_email),
      user_id=COALESCE(customer_deletion_jobs.user_id,EXCLUDED.user_id),
      next_attempt_at=CASE WHEN customer_deletion_jobs.status='running' THEN customer_deletion_jobs.next_attempt_at ELSE NOW() END,
      updated_at=NOW()
    RETURNING *
  `,[customerId,row.user_id||null,row.name||null,row.email||null,actorUserId||null,String(reason||'Portal customer deleted by administrator').slice(0,1000)]);
  return created.rows[0];
}

async function claimDeletionJob(jobId){
  const claimed=await query(`
    UPDATE customer_deletion_jobs
    SET status='running',attempt_count=attempt_count+1,started_at=COALESCE(started_at,NOW()),last_error=NULL,updated_at=NOW()
    WHERE id=$1 AND (
      (status IN ('pending','failed') AND next_attempt_at<=NOW())
      OR (status='running' AND updated_at<NOW()-make_interval(mins=>$2))
    )
    RETURNING *
  `,[jobId,RUNNING_STALE_MINUTES]);
  if(claimed.rowCount)return claimed.rows[0];
  const existing=await query('SELECT * FROM customer_deletion_jobs WHERE id=$1',[jobId]);
  if(!existing.rowCount)throw new Error('Customer deletion job not found.');
  if(existing.rows[0].status==='succeeded')return existing.rows[0];
  const error=new Error('Customer deletion job is already running or waiting for its retry window.');
  error.code='CUSTOMER_DELETION_IN_PROGRESS';
  error.jobId=jobId;
  throw error;
}

async function markDeletionFailed(job,error,jellyfinResults=null){
  const minutes=retryMinutes(job.attempt_count);
  await query(`
    UPDATE customer_deletion_jobs
    SET status='failed',last_error=$2,
        jellyfin_results=COALESCE($3::jsonb,jellyfin_results),
        next_attempt_at=NOW()+make_interval(mins=>$4),updated_at=NOW()
    WHERE id=$1
  `,[job.id,message(error),jellyfinResults?JSON.stringify(jellyfinResults):null,minutes]);
}

async function ensureDeletionHold(job){
  if(job.access_held_at)return job;
  await provisioning.holdAccess(job.customer_id,'jellyfin_deleted',job.actor_user_id||null);
  const held=await query(`UPDATE customer_deletion_jobs SET access_held_at=COALESCE(access_held_at,NOW()),updated_at=NOW() WHERE id=$1 RETURNING *`,[job.id]);
  return held.rows[0]||job;
}

async function finalizePortalDeletion(job,jellyfin){
  return transaction(async client=>{
    const existing=await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[job.customer_id]);
    if(!existing.rowCount)throw new Error('Customer disappeared before the deletion job could finish safely.');

    // Local Jellyfin identity rows are deliberately retained until every remote
    // user has been confirmed deleted/missing. If this transaction rolls back,
    // the next attempt sees those rows again and remote 404s make it resumable.
    await client.query('DELETE FROM jellyfin_accounts WHERE customer_id=$1',[job.customer_id]);
    await client.query('DELETE FROM content_requests WHERE customer_id=$1',[job.customer_id]);
    await client.query('DELETE FROM customer_bans WHERE customer_id=$1 OR ($2::text IS NOT NULL AND normalized_email=LOWER(BTRIM($2::text)))',[job.customer_id,job.customer_email||null]);
    await client.query('DELETE FROM customer_download_events WHERE customer_id=$1',[job.customer_id]);
    await client.query('DELETE FROM free_access_registration_reservations WHERE customer_id=$1',[job.customer_id]);
    await client.query('DELETE FROM payment_incidents WHERE customer_id=$1',[job.customer_id]);
    await client.query('DELETE FROM playback_history WHERE customer_id=$1',[job.customer_id]);
    await client.query('DELETE FROM stream_policy_events WHERE customer_id=$1',[job.customer_id]);
    await client.query('DELETE FROM affiliate_credit_ledger WHERE referred_customer_id=$1',[job.customer_id]);
    // Audit history remains append-only. PostgreSQL may clear actor_user_id when
    // the deleted portal user itself was an audit actor via ON DELETE SET NULL.
    await client.query('DELETE FROM customers WHERE id=$1',[job.customer_id]);
    if(job.user_id){
      await client.query('DELETE FROM auth_events WHERE user_id=$1',[job.user_id]);
      await client.query("SELECT set_config('steamfusion.allow_audit_mutation','on',true)");
      try{
        await client.query(`DELETE FROM app_users WHERE id=$1 AND role='customer' AND NOT EXISTS(SELECT 1 FROM customers WHERE user_id=$1)`,[job.user_id]);
      }finally{
        await client.query("SELECT set_config('steamfusion.allow_audit_mutation','off',true)");
      }
    }
    const result={customerId:job.customer_id,name:job.customer_name,email:job.customer_email,jellyfin,deleted:true,jobId:job.id};
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.hard_delete','customer_deleted',$2,$3::jsonb)`,[job.actor_user_id||null,String(job.customer_id),JSON.stringify({reason:job.reason,deletionJobId:job.id,jellyfin:{total:jellyfin.total,deleted:jellyfin.deleted,alreadyMissing:jellyfin.alreadyMissing}})]);
    await client.query(`UPDATE customer_deletion_jobs SET status='succeeded',completed_at=NOW(),last_error=NULL,jellyfin_results=$2::jsonb,result=$3::jsonb,updated_at=NOW() WHERE id=$1`,[job.id,JSON.stringify(jellyfin.results||[]),JSON.stringify(result)]);
    return result;
  });
}

async function processDeletionJob(jobId){
  let job=await claimDeletionJob(jobId);
  if(job.status==='succeeded')return job.result||{customerId:job.customer_id,deleted:true,jobId:job.id};
  try{
    job=await ensureDeletionHold(job);
    let jellyfin;
    try{
      // Do not remove local rows here. They are the durable inventory needed to
      // retry safely if one server or the final database transaction fails.
      jellyfin=await deleteJellyfinAccounts(job.customer_id,{actorUserId:job.actor_user_id||null,reason:job.reason,holdAccess:false,removeLocal:false,continueOnMissing:true});
    }catch(error){
      await markDeletionFailed(job,error,error.deletionResults||null);
      throw pendingError(job,error);
    }
    await query('UPDATE customer_deletion_jobs SET jellyfin_results=$2::jsonb,updated_at=NOW() WHERE id=$1',[job.id,JSON.stringify(jellyfin.results||[])]);
    try{
      return await finalizePortalDeletion(job,jellyfin);
    }catch(error){
      await markDeletionFailed(job,error,jellyfin.results||[]);
      throw pendingError(job,error);
    }
  }catch(error){
    if(error?.code==='CUSTOMER_DELETION_PENDING')throw error;
    await markDeletionFailed(job,error).catch(()=>{});
    throw pendingError(job,error);
  }
}

async function processDue({limit=10}={}){
  const max=Math.max(1,Math.min(100,Number(limit)||10));
  const due=await query(`
    SELECT id FROM customer_deletion_jobs
    WHERE (status IN ('pending','failed') AND next_attempt_at<=NOW())
       OR (status='running' AND updated_at<NOW()-make_interval(mins=>$2))
    ORDER BY next_attempt_at,created_at
    LIMIT $1
  `,[max,RUNNING_STALE_MINUTES]);
  let succeeded=0,failed=0;
  const failures=[];
  for(const row of due.rows){
    try{await processDeletionJob(row.id);succeeded+=1;}
    catch(error){failed+=1;failures.push({jobId:row.id,error:message(error)});}
  }
  return{total:due.rowCount,processed:due.rowCount,succeeded,failed,failures};
}

async function hardDeletePortalCustomer(customerId,{actorUserId=null,reason='Portal customer deleted by administrator'}={}){
  const job=await enqueueHardDelete(customerId,{actorUserId,reason});
  try{return await processDeletionJob(job.id);}
  catch(error){
    if(error?.code==='CUSTOMER_DELETION_IN_PROGRESS')throw error;
    if(error?.code==='CUSTOMER_DELETION_PENDING')throw error;
    throw pendingError(job,error);
  }
}

module.exports={
  RUNNING_STALE_MINUTES,
  RETRY_MINUTES,
  message,
  isRemoteMissing,
  retryMinutes,
  deleteJellyfinAccounts,
  enqueueHardDelete,
  claimDeletionJob,
  processDeletionJob,
  processDue,
  hardDeletePortalCustomer
};
