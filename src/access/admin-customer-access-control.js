'use strict';

const {query,transaction}=require('../db');
const accessHolds=require('../entitlements/access-holds');
const inactivityRestore=require('../entitlements/jellyfin-inactivity-restore');
const provisioning=require('../jellyfin/resilient-provisioning');
const reconciliationControl=require('../jellyfin/reconciliation-control');

const MANUAL_RELEASE_TYPES=new Set(['inactivity_policy','jellyfin_cleanup','admin_disabled','admin_suspended','admin_hold','legacy']);

function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function normalizedEmail(value){return String(value||'').trim().toLowerCase();}

async function reconcileCustomerForAdmin(customerId,actorUserId,{forceDue=false}={}){
  if(forceDue)await reconciliationControl.forceCustomerDue(customerId);
  const outcome=await provisioning.reconcileCustomer(customerId);
  const blockers=Array.isArray(outcome?.blockers)?outcome.blockers:[];
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.service.reconcile','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({status:outcome?.status||null,active:Boolean(outcome?.active),forced:Boolean(forceDue),blockers:blockers.map(row=>({type:row.type,sourceKey:row.sourceKey||null}))})]);
  return outcome;
}

async function forceReleaseAllHolds(customerId,actorUserId){
  return transaction(async client=>{
    const released=await client.query(`
      UPDATE customer_access_holds
      SET released_at=NOW(),released_by=$2
      WHERE customer_id=$1 AND released_at IS NULL
      RETURNING id,hold_type,source_key
    `,[customerId,actorUserId]);
    await accessHolds.syncLegacySummary(customerId,client);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.customer.break_glass.clear_all_holds','customer',$2,$3::jsonb)`,[
        actorUserId,customerId,JSON.stringify({released:released.rowCount,holds:released.rows.map(row=>({id:row.id,type:row.hold_type,sourceKey:row.source_key||null}))})
      ]);
    return released.rows;
  });
}

async function matchingBanScope(client,customerId){
  const anchorResult=await client.query(`
    SELECT c.id,c.user_id,u.role,
           LOWER(BTRIM(COALESCE(c.email,''))) AS customer_email,
           LOWER(BTRIM(COALESCE(u.email,''))) AS login_email
    FROM customers c
    LEFT JOIN app_users u ON u.id=c.user_id
    WHERE c.id=$1
    FOR UPDATE OF c
  `,[customerId]);
  if(!anchorResult.rowCount)throw new Error('Customer not found.');
  const anchor=anchorResult.rows[0];
  const emails=[...new Set([normalizedEmail(anchor.customer_email),normalizedEmail(anchor.login_email)].filter(Boolean))];
  const scopeResult=await client.query(`
    SELECT DISTINCT c.id,c.user_id,u.role,
           LOWER(BTRIM(COALESCE(c.email,''))) AS customer_email,
           LOWER(BTRIM(COALESCE(u.email,''))) AS login_email
    FROM customers c
    LEFT JOIN app_users u ON u.id=c.user_id
    WHERE c.id=$1
       OR (
         COALESCE(array_length($2::text[],1),0)>0
         AND (u.id IS NULL OR u.role='customer')
         AND (
           LOWER(BTRIM(COALESCE(c.email,'')))=ANY($2::text[])
           OR LOWER(BTRIM(COALESCE(u.email,'')))=ANY($2::text[])
         )
       )
    ORDER BY c.id
  `,[customerId,emails]);
  const rows=scopeResult.rows;
  const allEmails=[...new Set(rows.flatMap(row=>[normalizedEmail(row.customer_email),normalizedEmail(row.login_email)]).filter(Boolean))];
  return{rows,customerIds:rows.map(row=>row.id),userIds:[...new Set(rows.filter(row=>row.user_id&&row.role==='customer').map(row=>row.user_id))],emails:allEmails};
}

async function reconcileBanScope(customerIds,actorUserId){
  const warnings=[];
  for(const customerId of customerIds){
    try{await reconcileCustomerForAdmin(customerId,actorUserId);}
    catch(error){warnings.push(`${String(customerId).slice(0,8)}: ${clean(error.message||error,180)}`);}
  }
  return warnings;
}

async function banCustomer(customerId,actorUserId,reason){
  if(!actorUserId)throw new Error('An authenticated administrator is required to ban a customer.');
  const cleanReason=clean(reason,500);
  if(cleanReason.length<3)throw new Error('Enter a ban reason of at least 3 characters.');
  const result=await transaction(async client=>{
    const scope=await matchingBanScope(client,customerId);
    if(!scope.customerIds.length)throw new Error('No customer identities were found for this ban.');

    for(const row of scope.rows){
      const rowEmail=normalizedEmail(row.login_email)||normalizedEmail(row.customer_email)||scope.emails[0]||null;
      const existing=await client.query(`SELECT id FROM customer_bans WHERE customer_id=$1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1`,[row.id]);
      if(existing.rowCount){
        await client.query(`UPDATE customer_bans SET normalized_email=COALESCE(NULLIF(normalized_email,''),$2),reason=$3,blocks_registration=TRUE,blocks_service_access=TRUE,created_by=COALESCE(created_by,$4) WHERE id=$1`,[existing.rows[0].id,rowEmail,cleanReason,actorUserId]);
      }else{
        await client.query(`INSERT INTO customer_bans(customer_id,normalized_email,reason,blocks_registration,blocks_service_access,created_by) VALUES($1,$2,$3,TRUE,TRUE,$4)`,[row.id,rowEmail,cleanReason,actorUserId]);
      }
      await accessHolds.addHold({customerId:row.id,type:'admin_hold',sourceKey:'admin',reason:`Administrative ban: ${cleanReason}`,actorUserId,metadata:{origin:'customer_360',requestedCustomerId:customerId,emails:scope.emails}},client);
    }

    for(const email of scope.emails){
      const existingEmail=await client.query(`SELECT id FROM customer_bans WHERE normalized_email=$1 AND revoked_at IS NULL LIMIT 1`,[email]);
      if(existingEmail.rowCount){
        await client.query(`UPDATE customer_bans SET reason=$2,blocks_registration=TRUE,blocks_service_access=TRUE,created_by=COALESCE(created_by,$3) WHERE id=$1`,[existingEmail.rows[0].id,cleanReason,actorUserId]);
      }else{
        await client.query(`INSERT INTO customer_bans(customer_id,normalized_email,reason,blocks_registration,blocks_service_access,created_by) VALUES($1,$2,$3,TRUE,TRUE,$4)`,[customerId,email,cleanReason,actorUserId]);
      }
    }

    let disabledPortalUsers=0,revokedSessions=0,revokedActivationLinks=0;
    if(scope.userIds.length){
      const disabled=await client.query(`UPDATE app_users SET active=FALSE,session_version=session_version+1,updated_at=NOW() WHERE id=ANY($1::uuid[]) AND role='customer' AND active IS DISTINCT FROM FALSE RETURNING id`,[scope.userIds]);
      disabledPortalUsers=disabled.rowCount;
      const sessions=await client.query(`UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=ANY($1::uuid[]) AND role='customer' AND revoked_at IS NULL RETURNING session_id`,[scope.userIds]);
      revokedSessions=sessions.rowCount;
      const sessionIds=sessions.rows.map(row=>row.session_id).filter(Boolean);
      if(sessionIds.length)await client.query(`DELETE FROM user_sessions WHERE sid=ANY($1::text[])`,[sessionIds]);
      const activations=await client.query(`UPDATE account_activation_tokens SET revoked_at=NOW() WHERE user_id=ANY($1::uuid[]) AND purpose='customer_activation' AND used_at IS NULL AND revoked_at IS NULL`,[scope.userIds]);
      revokedActivationLinks=activations.rowCount;
    }

    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.ban','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({reason:cleanReason,customerIds:scope.customerIds,emails:scope.emails,disabledPortalUsers,revokedSessions,revokedActivationLinks,duplicateIdentityCount:Math.max(0,scope.customerIds.length-1)})]);
    return{...scope,disabledPortalUsers,revokedSessions,revokedActivationLinks};
  });
  return{...result,reconcileWarnings:await reconcileBanScope(result.customerIds,actorUserId)};
}

async function unbanCustomer(customerId,actorUserId,reason){
  if(!actorUserId)throw new Error('An authenticated administrator is required to remove a ban.');
  const cleanReason=clean(reason,500);
  if(cleanReason.length<5)throw new Error('Enter an unban reason of at least 5 characters.');
  const result=await transaction(async client=>{
    const scope=await matchingBanScope(client,customerId);
    const revoked=await client.query(`
      UPDATE customer_bans
      SET revoked_at=NOW(),revoked_by=$2
      WHERE revoked_at IS NULL
        AND (customer_id=ANY($1::uuid[]) OR (COALESCE(array_length($3::text[],1),0)>0 AND normalized_email=ANY($3::text[])))
      RETURNING id
    `,[scope.customerIds,actorUserId,scope.emails]);
    let releasedHolds=0;
    for(const id of scope.customerIds){
      releasedHolds+=await accessHolds.releaseHold({customerId:id,type:'administrative_ban',sourceKey:'ban',actorUserId,resolutionReason:cleanReason},client);
    }
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.unban','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({reason:cleanReason,customerIds:scope.customerIds,emails:scope.emails,revokedBanRows:revoked.rowCount,releasedHolds,portalAccountsReenabled:false})]);
    return{...scope,revokedBanRows:revoked.rowCount,releasedHolds};
  });
  return{...result,reconcileWarnings:await reconcileBanScope(result.customerIds,actorUserId)};
}

async function releaseCustomerHold(customerId,holdId,actorUserId,resolutionReason){
  const reason=clean(resolutionReason,500);
  if(reason.length<5)throw new Error('Enter a release reason of at least 5 characters for the audit trail.');
  let releasedType='',selectedSourceKey='';
  await transaction(async client=>{
    const selected=await client.query(`SELECT * FROM customer_access_holds WHERE id=$1 AND customer_id=$2 AND released_at IS NULL FOR UPDATE`,[holdId,customerId]);
    if(!selected.rowCount)throw new Error('This hold is no longer active. Refresh the customer page.');
    const hold=selected.rows[0],type=String(hold.hold_type||'');
    if(type==='payment_risk')throw new Error('Payment-risk holds can only be released through the payment incident workflow after provider verification.');
    if(!MANUAL_RELEASE_TYPES.has(type))throw new Error(`The ${type||'unknown'} hold is owned by a specialized workflow and cannot be released here.`);
    releasedType=type;
    selectedSourceKey=String(hold.source_key||'');
    if(type==='inactivity_policy')return;
    const count=await accessHolds.releaseHold({customerId,type,sourceKey:hold.source_key,actorUserId,resolutionReason:reason},client);
    if(count!==1)throw new Error('The hold changed before it could be released. Refresh and try again.');
  });

  if(releasedType==='inactivity_policy'){
    try{
      await inactivityRestore.restoreDisabledFreeAccess(customerId,{
        actorUserId,
        reconcile:id=>reconcileCustomerForAdmin(id,actorUserId)
      });
      return{releasedType,selectedSourceKey,restoredInactivity:true,remainingBlockers:0};
    }catch(error){
      error.inactivityRestoreFailed=true;
      error.releasedType=releasedType;
      error.selectedSourceKey=selectedSourceKey;
      throw error;
    }
  }
  try{
    const outcome=await reconcileCustomerForAdmin(customerId,actorUserId);
    return{
      releasedType,
      selectedSourceKey,
      restoredInactivity:false,
      remainingBlockers:Array.isArray(outcome?.blockers)?outcome.blockers.length:0
    };
  }catch(error){
    error.holdReleaseCommitted=true;
    error.releasedType=releasedType;
    error.selectedSourceKey=selectedSourceKey;
    throw error;
  }
}



async function clearAutomationProtection(customerId){
  const result=await query(`
    UPDATE customers
       SET automation_protected=FALSE,
           automation_protected_reason=NULL,
           automation_protected_at=NULL,
           automation_protected_by=NULL,
           updated_at=NOW()
     WHERE id=$1
     RETURNING id
  `,[customerId]);
  if(!result.rowCount)throw new Error('Customer not found.');
  return true;
}

module.exports={
  MANUAL_RELEASE_TYPES,
  clean,
  normalizedEmail,
  reconcileCustomerForAdmin,
  forceReleaseAllHolds,
  matchingBanScope,
  reconcileBanScope,
  banCustomer,
  unbanCustomer,
  releaseCustomerHold,
  clearAutomationProtection
};
