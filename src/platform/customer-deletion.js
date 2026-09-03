'use strict';

const {query}=require('../db');
const registry=require('../jellyfin/registry');
const provisioning=require('../jellyfin/provisioning');
const externalDeletion=require('./customer-external-deletion');

const RUNNING_STALE_MINUTES=15;
const RETRY_MINUTES=[1,5,15,60,180,360];

function message(error){return String(error?.message||error||'Unknown error').slice(0,1000);}
function isRemoteMissing(error){const value=message(error);return Number(error?.status)===404||/\b404\b|not found|not\s+exist/i.test(value);}
function retryMinutes(attempt){const n=Math.max(1,Number(attempt)||1);return RETRY_MINUTES[Math.min(n-1,RETRY_MINUTES.length-1)];}
function pendingError(job,error){
  const out=new Error(`Customer deletion is pending and will retry automatically: ${message(error)}`);
  out.code='CUSTOMER_DELETION_PENDING';out.jobId=job?.id||null;out.cause=error;
  if(Array.isArray(error?.blockingTargets))out.blockingTargets=error.blockingTargets;
  return out;
}

// Kept as a compatibility utility for callers that explicitly delete Jellyfin
// identities. The hard-deletion saga below uses durable per-resource targets.
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

async function existingDeletion(customerId){
  const existing=await query(`SELECT * FROM customer_deletion_jobs WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`,[customerId]);
  return existing.rows[0]||null;
}

async function enqueueHardDelete(customerId,{actorUserId=null,reason='Portal customer deleted by administrator'}={}){
  // Idempotency also works after the canonical customer row is gone: a replay
  // of the same hard-delete operation returns the durable succeeded tombstone.
  const prior=await existingDeletion(customerId);
  if(prior&&prior.status==='succeeded')return prior;
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

async function markDeletionFailedBestEffort(job,error,jellyfinResults=null){
  try{
    await markDeletionFailed(job,error,jellyfinResults);
    return true;
  }catch(writeError){
    console.error('Unable to persist customer deletion failure state.',{jobId:job?.id||null,error:message(writeError)});
    return false;
  }
}

async function currentJellyfinDeletionResults(jobId){
  try{
    const current=await externalDeletion.listTargets(jobId);
    return externalDeletion.jellyfinResultsFromTargets(current);
  }catch(error){
    // A diagnostic read failure must not be converted into an empty result set:
    // doing so would overwrite previously durable deletion proof with [].
    console.warn('Unable to reload customer deletion targets after a failed cleanup attempt.',{jobId,error:message(error)});
    return null;
  }
}

async function ensureDeletionHold(job){
  if(job.access_held_at)return job;
  await provisioning.holdAccess(job.customer_id,'jellyfin_deleted',job.actor_user_id||null);
  const held=await query(`UPDATE customer_deletion_jobs SET access_held_at=COALESCE(access_held_at,NOW()),updated_at=NOW() WHERE id=$1 RETURNING *`,[job.id]);
  return held.rows[0]||job;
}

async function finalizePortalDeletion(job,jellyfin){
  // SECURITY DEFINER independently checks both the durable target gate and the
  // legacy per-Jellyfin-account proof before deleting canonical identities.
  const finalized=await query('SELECT public.finalize_customer_deletion($1) AS result',[job.id]);
  return finalized.rows[0]?.result||{customerId:job.customer_id,name:job.customer_name,email:job.customer_email,jellyfin,deleted:true,jobId:job.id};
}

async function processDeletionJob(jobId){
  let job=await claimDeletionJob(jobId);
  if(job.status==='succeeded')return job.result||{customerId:job.customer_id,deleted:true,jobId:job.id};
  try{
    // 1) authoritative hold first: normal provisioning may remove access, but
    // must not create/re-add it while cleanup identity is being snapshotted.
    job=await ensureDeletionHold(job);

    // 2) snapshot every currently-owned cleanup identity before any destructive
    // external API call. A crash immediately after this point is recoverable.
    await externalDeletion.persistTargets(job);

    let targets;
    try{
      // 3) each target is an idempotent desired-state operation with durable
      // attempts/error/result. Discord removal is awaited and verified here.
      targets=await externalDeletion.reconcileJobTargets(job);
    }catch(error){
      const jellyfinResults=await currentJellyfinDeletionResults(job.id);
      await markDeletionFailedBestEffort(job,error,jellyfinResults);
      throw pendingError(job,error);
    }

    // Preserve the original Jellyfin proof consumed by the privileged
    // finalizer. The values are now derived from succeeded durable targets.
    const jellyfinResults=externalDeletion.jellyfinResultsFromTargets(targets);
    await query('UPDATE customer_deletion_jobs SET jellyfin_results=$2::jsonb,updated_at=NOW() WHERE id=$1',[job.id,JSON.stringify(jellyfinResults)]);

    try{return await finalizePortalDeletion(job,{results:jellyfinResults});}
    catch(error){
      await markDeletionFailedBestEffort(job,error,jellyfinResults);
      throw pendingError(job,error);
    }
  }catch(error){
    if(error?.code==='CUSTOMER_DELETION_PENDING')throw error;
    await markDeletionFailedBestEffort(job,error);
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
    catch(error){failed+=1;failures.push({jobId:row.id,error:message(error),blockingTargets:error?.blockingTargets||[]});}
  }
  return{total:due.rowCount,processed:due.rowCount,succeeded,failed,failures};
}

async function hardDeletePortalCustomer(customerId,{actorUserId=null,reason='Portal customer deleted by administrator'}={}){
  const job=await enqueueHardDelete(customerId,{actorUserId,reason});
  if(job.status==='succeeded')return job.result||{customerId:job.customer_id,deleted:true,jobId:job.id};
  try{return await processDeletionJob(job.id);}
  catch(error){
    if(error?.code==='CUSTOMER_DELETION_IN_PROGRESS')throw error;
    if(error?.code==='CUSTOMER_DELETION_PENDING')throw error;
    throw pendingError(job,error);
  }
}

async function deletionStatus(options){return externalDeletion.deletionStatus(options);}

module.exports={
  RUNNING_STALE_MINUTES,
  RETRY_MINUTES,
  message,
  isRemoteMissing,
  retryMinutes,
  deleteJellyfinAccounts,
  enqueueHardDelete,
  claimDeletionJob,
  markDeletionFailedBestEffort,
  currentJellyfinDeletionResults,
  processDeletionJob,
  processDue,
  hardDeletePortalCustomer,
  deletionStatus
};