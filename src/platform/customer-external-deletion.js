'use strict';

const {query,transaction}=require('../db');
const registry=require('../jellyfin/registry');
const requestUsers=require('../integrations/request-user-sync');
const discordRoles=require('../integrations/discord-roles');
const notificationSettings=require('../integrations/notification-settings');
const stremioEntitlements=require('../stremio/entitlements');
const billingControl=require('../payments/billing-control');

const RETRY_MINUTES=[1,5,15,60,180,360];

function message(error){return String(error?.message||error||'Unknown error').replace(/\s+/g,' ').trim().slice(0,1000);}
function isRemoteMissing(error){const value=message(error);return Number(error?.status)===404||/\b404\b|not found|not\s+exist/i.test(value);}
function retryMinutes(attempt){const n=Math.max(1,Number(attempt)||1);return RETRY_MINUTES[Math.min(n-1,RETRY_MINUTES.length-1)];}
function json(value){return JSON.stringify(value==null?{}:value);}

async function insertTarget(client,{jobId,customerId,provider,resourceType,externalIdentifier,desiredState='absent',metadata={}}){
  if(!externalIdentifier)return;
  await client.query(`
    INSERT INTO customer_external_deletion_targets(
      deletion_job_id,customer_id,provider,resource_type,external_identifier,desired_state,metadata,state,next_attempt_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'pending',NOW(),NOW())
    ON CONFLICT(deletion_job_id,provider,resource_type,external_identifier) DO UPDATE SET
      desired_state=EXCLUDED.desired_state,
      metadata=customer_external_deletion_targets.metadata||EXCLUDED.metadata,
      updated_at=NOW()
  `,[jobId,customerId,provider,resourceType,String(externalIdentifier),desiredState,json(metadata)]);
}

async function discordSnapshot(){
  try{
    const status=await notificationSettings.status();
    return{guildId:status?.discordGuildId||null,configured:Boolean(status?.discordConfigured&&status?.discordGuildId),error:null};
  }catch(error){return{guildId:null,configured:false,error:message(error)};}
}

async function persistTargets(job){
  const discord=await discordSnapshot();
  return transaction(async client=>{
    const locked=await client.query('SELECT * FROM customer_deletion_jobs WHERE id=$1 FOR UPDATE',[job.id]);
    if(!locked.rowCount)throw new Error('Customer deletion job not found while persisting external targets.');

    // Always refresh the inventory before finalization. Inserts are idempotent,
    // and this lets a newer release add newly-recognized external resources to
    // an already-pending deletion job without trusting an older snapshot as complete.
    const jellyfin=await client.query(`
      SELECT id,server_id,jellyfin_user_id,jellyfin_username,account_purpose
      FROM jellyfin_accounts WHERE customer_id=$1 ORDER BY created_at,id
    `,[job.customer_id]);
    for(const account of jellyfin.rows){
      await insertTarget(client,{
        jobId:job.id,customerId:job.customer_id,provider:'jellyfin',resourceType:'user',
        externalIdentifier:`${account.server_id}:${account.jellyfin_user_id||account.id}`,desiredState:'absent',
        metadata:{accountId:account.id,serverId:account.server_id,jellyfinUserId:account.jellyfin_user_id,username:account.jellyfin_username,accountPurpose:account.account_purpose||'customer'}
      });
    }

    const request=await client.query(`
      SELECT external_user_id,external_email,external_username,status
      FROM request_user_sync WHERE customer_id=$1
    `,[job.customer_id]);
    for(const row of request.rows){
      const remoteId=row.external_user_id==null?null:String(row.external_user_id);
      const email=String(row.external_email||job.customer_email||'').trim().toLowerCase()||null;
      const username=String(row.external_username||'').trim()||null;
      const locator=remoteId||email||username;
      if(locator)await insertTarget(client,{
        jobId:job.id,customerId:job.customer_id,provider:'request_service',resourceType:'permissions',
        externalIdentifier:remoteId||`identity:${locator}`,desiredState:'permissions:0',
        metadata:{externalUserId:remoteId,email,username,everProvisioned:row.status==='synced',verificationVersion:2}
      });
    }

    const recurring=await client.query(`
      SELECT id,source,provider_subscription_id,status,current_period_end,cancel_at_period_end
      FROM subscriptions
      WHERE customer_id=$1
        AND (
          (source='stripe' AND provider_subscription_id LIKE 'sub\\_%' ESCAPE '\\')
          OR (source='paypal' AND provider_subscription_id LIKE 'I-%')
        )
      ORDER BY created_at,id
    `,[job.customer_id]);
    for(const subscription of recurring.rows){
      await insertTarget(client,{
        jobId:job.id,customerId:job.customer_id,provider:subscription.source,resourceType:'recurring_subscription',
        externalIdentifier:subscription.provider_subscription_id,desiredState:'cancelled',
        metadata:{
          subscriptionId:subscription.id,
          providerSubscriptionId:subscription.provider_subscription_id,
          localStatus:subscription.status,
          currentPeriodEnd:subscription.current_period_end,
          cancelAtPeriodEnd:Boolean(subscription.cancel_at_period_end),
          inventoryVersion:2
        }
      });
    }

    const preference=await client.query(`
      SELECT discord_user_id FROM customer_communication_preferences
      WHERE customer_id=$1 AND discord_user_id IS NOT NULL AND discord_user_id<>''
    `,[job.customer_id]);
    const discordUserId=preference.rows[0]?.discord_user_id||null;
    if(discordUserId){
      const roles=await client.query(`SELECT DISTINCT discord_role_id FROM plans WHERE discord_role_id IS NOT NULL AND discord_role_id<>'' ORDER BY discord_role_id`);
      for(const role of roles.rows){
        await insertTarget(client,{
          jobId:job.id,customerId:job.customer_id,provider:'discord',resourceType:'managed_role',
          externalIdentifier:`${discordUserId}:${role.discord_role_id}`,desiredState:'absent',
          metadata:{discordUserId,roleId:role.discord_role_id,guildId:discord.guildId,discordConfiguredAtSnapshot:discord.configured,configurationError:discord.error}
        });
      }
    }

    const stremio=await client.query(`
      SELECT id,subscription_id,status,(token_hash IS NOT NULL) AS had_install_credential
      FROM stremio_entitlements
      WHERE customer_id=$1 AND (status<>'revoked' OR token_hash IS NOT NULL)
      ORDER BY created_at,id
    `,[job.customer_id]);
    for(const entitlement of stremio.rows){
      await insertTarget(client,{
        jobId:job.id,customerId:job.customer_id,provider:'stremio',resourceType:'install_credential',
        externalIdentifier:String(entitlement.id),desiredState:'revoked',
        metadata:{entitlementId:entitlement.id,subscriptionId:entitlement.subscription_id,hadInstallCredential:Boolean(entitlement.had_install_credential)}
      });
    }

    await client.query(`UPDATE customer_deletion_jobs SET targets_persisted_at=COALESCE(targets_persisted_at,NOW()),updated_at=NOW() WHERE id=$1`,[job.id]);
    const targets=await client.query('SELECT * FROM customer_external_deletion_targets WHERE deletion_job_id=$1 ORDER BY created_at,id',[job.id]);
    return targets.rows;
  });
}

async function deleteJellyfinTarget(target){
  const meta=target.metadata||{};
  if(!meta.serverId||!meta.jellyfinUserId)throw new Error(`Jellyfin target ${target.external_identifier} is missing its durable server/user identity.`);
  try{
    await registry.request(meta.serverId,`/Users/${encodeURIComponent(meta.jellyfinUserId)}`,{method:'DELETE',timeoutMs:15000});
    return{status:'deleted'};
  }catch(error){
    if(isRemoteMissing(error))return{status:'already_missing'};
    throw error;
  }
}

async function resolveRequestUser(target){
  const meta=target.metadata||{};
  if(meta.externalUserId)return String(meta.externalUserId);
  const users=await requestUsers.externalUsers();
  const email=String(meta.email||'').trim().toLowerCase();
  const username=String(meta.username||'').trim().toLowerCase();
  const found=users.find(user=>(email&&String(user?.email||'').trim().toLowerCase()===email)||(username&&String(user?.username||'').trim().toLowerCase()===username));
  return found?.id==null?null:String(found.id);
}

async function revokeRequestTarget(target){
  const externalUserId=await resolveRequestUser(target);
  if(!externalUserId){
    if(target.metadata?.everProvisioned){
      throw new Error(`Request-service account for target ${target.external_identifier} was previously provisioned (status=synced) but could not be located by id, email, or username in the current user list; permissions cannot be confirmed revoked.`);
    }
    return{status:'already_missing',policy:'remote_account_retained_permissions_zero'};
  }
  try{
    let permissions=await requestUsers.permissionState(externalUserId);
    if(permissions!==0)await requestUsers.setPermissions(externalUserId,0);
    permissions=await requestUsers.permissionState(externalUserId);
    if(permissions!==0)throw new Error(`Request-service user ${externalUserId} still has permissions ${permissions} after revocation.`);
    return{status:'permissions_revoked',externalUserId,permissions:0,policy:'remote_account_retained_permissions_zero'};
  }catch(error){
    if(isRemoteMissing(error))return{status:'already_missing',externalUserId,policy:'remote_account_retained_permissions_zero'};
    throw error;
  }
}

async function cancelRecurringTarget(target){
  const meta=target.metadata||{};
  const providerSubscriptionId=String(meta.providerSubscriptionId||target.external_identifier||'').trim();
  if(!providerSubscriptionId)throw new Error(`${target.provider} recurring deletion target is missing its durable provider subscription identity.`);
  return billingControl.terminateRecurringForDeletion({
    id:meta.subscriptionId||null,
    customer_id:target.customer_id,
    source:target.provider,
    provider_subscription_id:providerSubscriptionId,
    status:meta.localStatus||null,
    current_period_end:meta.currentPeriodEnd||null,
    cancel_at_period_end:Boolean(meta.cancelAtPeriodEnd)
  },{idempotencyKey:`customer-delete-${target.id}`});
}

async function removeDiscordTarget(target){
  const meta=target.metadata||{};
  const discordUserId=String(meta.discordUserId||'').trim();
  const roleId=String(meta.roleId||'').trim();
  const status=await notificationSettings.status();
  const guildId=String(meta.guildId||status?.discordGuildId||'').trim();
  if(!discordUserId||!roleId)throw new Error(`Discord target ${target.external_identifier} is missing its durable user/role identity.`);
  if(!status?.discordConfigured||!guildId)throw new Error('Discord cleanup is blocked because the Discord bot/guild is not configured. The durable user/role target has been retained.');
  let current=await discordRoles.currentGuildRoles(guildId,discordUserId);
  if(current===null)return{status:'already_missing',guildId,discordUserId,roleId};
  if(current.has(roleId)){
    try{
      await notificationSettings.discordApi(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}/roles/${encodeURIComponent(roleId)}`,{method:'DELETE'});
    }catch(error){
      if(isRemoteMissing(error))return{status:'already_missing',guildId,discordUserId,roleId};
      throw error;
    }
  }
  current=await discordRoles.currentGuildRoles(guildId,discordUserId);
  if(current!==null&&current.has(roleId))throw new Error(`Discord role ${roleId} is still present after removal.`);
  return{status:'removed',guildId,discordUserId,roleId};
}

async function revokeStremioTarget(target){
  const entitlementId=String(target.metadata?.entitlementId||target.external_identifier||'').trim();
  await stremioEntitlements.revoke(target.customer_id);
  const current=await query('SELECT status,token_hash FROM stremio_entitlements WHERE id=$1',[entitlementId]);
  if(!current.rowCount)return{status:'already_missing'};
  const row=current.rows[0];
  if(row.status!=='revoked'||row.token_hash!==null)throw new Error(`Stremio entitlement ${entitlementId} did not converge to a revoked credential.`);
  return{status:'revoked'};
}

async function executeTarget(target){
  if(target.provider==='jellyfin'&&target.resource_type==='user')return deleteJellyfinTarget(target);
  if(target.provider==='request_service'&&target.resource_type==='permissions')return revokeRequestTarget(target);
  if(['stripe','paypal'].includes(target.provider)&&target.resource_type==='recurring_subscription')return cancelRecurringTarget(target);
  if(target.provider==='discord'&&target.resource_type==='managed_role')return removeDiscordTarget(target);
  if(target.provider==='stremio'&&target.resource_type==='install_credential')return revokeStremioTarget(target);
  throw new Error(`Unsupported external deletion target ${target.provider}/${target.resource_type}.`);
}

async function runTargetStateMachine(targets,{claim,execute,complete,fail}={}){
  const outcomes=[];
  for(const original of targets||[]){
    if(original.state==='succeeded'){outcomes.push({target:original,status:'succeeded',skipped:true});continue;}
    let target=original;
    try{
      target=await claim(original);
      const result=await execute(target);
      await complete(target,result);
      outcomes.push({target,status:'succeeded',result});
    }catch(error){
      try{await fail(target,error);}catch(failError){error.persistenceError=message(failError);}
      outcomes.push({target,status:'failed',error:message(error)});
    }
  }
  return outcomes;
}

async function listTargets(jobId){
  const result=await query('SELECT * FROM customer_external_deletion_targets WHERE deletion_job_id=$1 ORDER BY created_at,id',[jobId]);
  return result.rows;
}

async function reconcileJobTargets(job){
  const targets=await listTargets(job.id);
  await runTargetStateMachine(targets,{
    claim:async target=>{
      const claimed=await query(`
        UPDATE customer_external_deletion_targets
        SET state='running',attempt_count=attempt_count+1,last_attempt_at=NOW(),last_error=NULL,updated_at=NOW()
        WHERE id=$1 AND state<>'succeeded' RETURNING *
      `,[target.id]);
      return claimed.rows[0]||target;
    },
    execute:executeTarget,
    complete:async(target,result)=>{
      await query(`
        UPDATE customer_external_deletion_targets
        SET state='succeeded',result=$2::jsonb,last_error=NULL,completed_at=NOW(),next_attempt_at=NOW(),updated_at=NOW()
        WHERE id=$1
      `,[target.id,json(result)]);
    },
    fail:async(target,error)=>{
      const minutes=retryMinutes(target.attempt_count);
      await query(`
        UPDATE customer_external_deletion_targets
        SET state='failed',last_error=$2,next_attempt_at=NOW()+make_interval(mins=>$3),updated_at=NOW()
        WHERE id=$1 AND state<>'succeeded'
      `,[target.id,message(error),minutes]);
    }
  });
  const final=await listTargets(job.id);
  const incomplete=final.filter(row=>row.blocking&&row.state!=='succeeded');
  if(incomplete.length){
    const first=incomplete[0];
    const error=new Error(`External cleanup blocked by ${first.provider}/${first.resource_type} ${first.external_identifier}: ${first.last_error||first.state}`);
    error.code='EXTERNAL_DELETION_INCOMPLETE';
    error.blockingTargets=incomplete.map(row=>({id:row.id,provider:row.provider,resourceType:row.resource_type,externalIdentifier:row.external_identifier,state:row.state,attempts:row.attempt_count,nextRetry:row.next_attempt_at,lastError:row.last_error}));
    throw error;
  }
  return final;
}

function jellyfinResultsFromTargets(targets){
  return (targets||[]).filter(row=>row.provider==='jellyfin'&&row.resource_type==='user').map(row=>({
    accountId:row.metadata?.accountId,
    serverId:row.metadata?.serverId,
    jellyfinUserId:row.metadata?.jellyfinUserId,
    username:row.metadata?.username||row.metadata?.jellyfinUserId||row.external_identifier,
    status:row.result?.status||'failed',
    ...(row.last_error?{error:row.last_error}:{})
  }));
}

function targetSummary(targets){
  const rows=targets||[];
  return{
    total:rows.length,
    succeeded:rows.filter(row=>row.state==='succeeded').length,
    pending:rows.filter(row=>row.state!=='succeeded').length,
    blocking:rows.filter(row=>row.blocking&&row.state!=='succeeded').map(row=>({provider:row.provider,resourceType:row.resource_type,externalIdentifier:row.external_identifier,state:row.state,attempts:row.attempt_count,nextRetry:row.next_attempt_at,lastError:row.last_error}))
  };
}

async function deletionStatus({jobId=null,customerId=null}={}){
  let jobs;
  if(jobId)jobs=await query('SELECT * FROM customer_deletion_jobs WHERE id=$1',[jobId]);
  else if(customerId)jobs=await query('SELECT * FROM customer_deletion_jobs WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1',[customerId]);
  else throw new Error('jobId or customerId is required.');
  if(!jobs.rowCount)return null;
  const job=jobs.rows[0],targets=await listTargets(job.id);
  return{...job,targets,targetSummary:targetSummary(targets)};
}

module.exports={
  RETRY_MINUTES,message,isRemoteMissing,retryMinutes,persistTargets,executeTarget,runTargetStateMachine,
  listTargets,reconcileJobTargets,jellyfinResultsFromTargets,targetSummary,deletionStatus
};
