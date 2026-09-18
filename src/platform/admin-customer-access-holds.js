'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const accessHolds=require('../entitlements/access-holds');
const inactivityRestore=require('../entitlements/jellyfin-inactivity-restore');
const provisioning=require('../jellyfin/resilient-provisioning');
const reconciliationControl=require('../jellyfin/reconciliation-control');

const MANUAL_RELEASE_TYPES=new Set(['inactivity_policy','jellyfin_cleanup','admin_disabled','admin_suspended','admin_hold','legacy']);

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function accessPath(customerId,key,message){return `/admin/users/${encodeURIComponent(customerId)}?tab=access&${encodeURIComponent(key)}=${encodeURIComponent(message)}`;}
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

async function reconcileRoute(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
  const customerId=req.params.customerId;
  try{
    const outcome=await reconcileCustomerForAdmin(customerId,req.session.authUserId);
    const blockers=Array.isArray(outcome?.blockers)?outcome.blockers:[];
    const message=blockers.length
      ? `Reconciliation completed. Access remains restricted by ${blockers.length} active hold${blockers.length===1?'':'s'}; review Access status below.`
      : 'Service access reconciled against the current entitlement and active add-ons.';
    return res.redirect(accessPath(customerId,'message',message));
  }catch(error){
    console.error('Customer service reconciliation failed:',{customerId,error:error.message});
    return res.redirect(accessPath(customerId,'error',`Service reconciliation failed: ${clean(error.message||error,300)}`));
  }
}

async function forceReconcileRoute(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
  const customerId=req.params.customerId;
  try{
    const outcome=await reconcileCustomerForAdmin(customerId,req.session.authUserId,{forceDue:true});
    const blockers=Array.isArray(outcome?.blockers)?outcome.blockers:[];
    const message=blockers.length
      ? `Forced reconciliation ran immediately after resetting retry/backoff state. ${blockers.length} hold${blockers.length===1?' still blocks':'s still block'} access; use CLEAR ALL BLOCKERS to override them.`
      : 'Forced reconciliation ran immediately after resetting retry/backoff state.';
    return res.redirect(accessPath(customerId,'message',message));
  }catch(error){
    console.error('Forced customer reconciliation failed:',{customerId,error:error.message});
    return res.redirect(accessPath(customerId,'error',`Forced reconciliation failed: ${clean(error.message||error,300)}`));
  }
}

function createAdminCustomerAccessHoldsRouter(){
  const router=express.Router();
  router.use('/admin/users',gate,noStore);
  router.post('/admin/users/:customerId/manage/reconcile',reconcileRoute);
  router.post('/admin/users/:customerId/reconcile',reconcileRoute);

  router.post('/admin/users/:customerId/access-ban',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId;
    try{
      if(String(req.body.confirmation||'').trim().toUpperCase()!=='BAN')throw new Error('Type BAN to confirm this customer ban.');
      const result=await banCustomer(customerId,req.session.authUserId,req.body.reason);
      const scope=result.customerIds.length>1?` across ${result.customerIds.length} matching customer identities`:'';
      const email=result.emails.length?` ${result.emails.length} email address${result.emails.length===1?' is':'es are'} blocked from registration.`:' No email address was available to block from registration.';
      const warning=result.reconcileWarnings.length?` Warning: access reconciliation needs attention for ${result.reconcileWarnings.join('; ')}.`:'';
      return res.redirect(accessPath(customerId,'message',`Customer banned${scope}.${email} Portal logins were disabled and active sessions/onboarding links revoked.${warning}`));
    }catch(error){
      console.error('Customer ban failed:',{customerId,error:error.message});
      return res.redirect(accessPath(customerId,'error',clean(error.message||error,350)||'Could not ban this customer.'));
    }
  });

  router.post('/admin/users/:customerId/access-ban/revoke',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId;
    try{
      if(String(req.body.confirmation||'').trim().toUpperCase()!=='UNBAN')throw new Error('Type UNBAN to confirm removal of this customer ban.');
      const result=await unbanCustomer(customerId,req.session.authUserId,req.body.reason);
      const scope=result.customerIds.length>1?` across ${result.customerIds.length} matching customer identities`:'';
      const warning=result.reconcileWarnings.length?` Warning: access reconciliation needs attention for ${result.reconcileWarnings.join('; ')}.`:'';
      return res.redirect(accessPath(customerId,'message',`Administrative ban removed${scope}. Matching email registration bans were revoked. Portal logins remain disabled until explicitly re-enabled.${warning}`));
    }catch(error){
      console.error('Customer unban failed:',{customerId,error:error.message});
      return res.redirect(accessPath(customerId,'error',clean(error.message||error,350)||'Could not remove this customer ban.'));
    }
  });

  // Break-glass routes intentionally bypass ordinary workflow ownership.
  // They are admin-only, CSRF-protected and audited, but require no reason or
  // typed confirmation: their job is to recover a customer when automation is stuck.
  router.post('/admin/users/:customerId/manage/force/reconcile',forceReconcileRoute);
  router.post('/admin/users/:customerId/manage/force/clear-blockers',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId;
    try{
      const released=await forceReleaseAllHolds(customerId,req.session.authUserId);
      let reconcileError='';
      try{await reconcileCustomerForAdmin(customerId,req.session.authUserId,{forceDue:true});}catch(error){reconcileError=clean(error.message||error,240);}
      const prefix=`Break-glass override cleared ${released.length} active blocker${released.length===1?'':'s'}, including specialized/payment-risk holds.`;
      return res.redirect(accessPath(customerId,reconcileError?'error':'message',reconcileError?`${prefix} Reconciliation then failed: ${reconcileError}. The holds remain cleared.`:prefix));
    }catch(error){
      return res.redirect(accessPath(customerId,'error',`Could not clear blockers: ${clean(error.message||error,300)}`));
    }
  });

  router.post('/admin/users/:customerId/access-holds/:holdId/release',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId,holdId=String(req.params.holdId||'').trim();
    try{
      if(String(req.body.confirmation||'').trim().toUpperCase()!=='RELEASE')throw new Error('Type RELEASE to confirm this access change.');
      const resolutionReason=clean(req.body.reason,500);
      if(resolutionReason.length<5)throw new Error('Enter a release reason of at least 5 characters for the audit trail.');
      let releasedType='',selectedSourceKey='';
      await transaction(async client=>{
        const selected=await client.query(`SELECT * FROM customer_access_holds WHERE id=$1 AND customer_id=$2 AND released_at IS NULL FOR UPDATE`,[holdId,customerId]);
        if(!selected.rowCount)throw new Error('This hold is no longer active. Refresh the customer page.');
        const hold=selected.rows[0],type=String(hold.hold_type||'');
        if(type==='payment_risk')throw new Error('Payment-risk holds can only be released through the payment incident workflow after provider verification.');
        if(!MANUAL_RELEASE_TYPES.has(type))throw new Error(`The ${type||'unknown'} hold is owned by a specialized workflow and cannot be released here.`);
        releasedType=type;
        selectedSourceKey=String(hold.source_key||'');
        // Inactivity restoration owns its own release + reprovision + rollback
        // transaction. Do not pre-release that hold through the generic route.
        if(type==='inactivity_policy')return;
        const count=await accessHolds.releaseHold({customerId,type,sourceKey:hold.source_key,actorUserId:req.session.authUserId,resolutionReason},client);
        if(count!==1)throw new Error('The hold changed before it could be released. Refresh and try again.');
      });
      try{
        if(releasedType==='inactivity_policy'){
          await inactivityRestore.restoreDisabledFreeAccess(customerId,{
            actorUserId:req.session.authUserId,
            reconcile:id=>reconcileCustomerForAdmin(id,req.session.authUserId)
          });
          return res.redirect(accessPath(customerId,'message','Free Server inactivity removal was cleared and Free access was restored.'));
        }
        const outcome=await reconcileCustomerForAdmin(customerId,req.session.authUserId);
        const remaining=Array.isArray(outcome?.blockers)?outcome.blockers.length:0;
        const message=remaining
          ? `Access hold released. ${remaining} other active hold${remaining===1?' remains':'s remain'}, so access is still restricted.`
          : 'Access hold released and service access reconciled against the current entitlement.';
        return res.redirect(accessPath(customerId,'message',message));
      }catch(error){
        console.error('Customer hold release reconciliation failed:',{customerId,holdId,holdType:releasedType,sourceKey:selectedSourceKey,error:error.message});
        const prefix=releasedType==='inactivity_policy'?'Free Server access was not restored':'The hold was released, but service reconciliation failed';
        return res.redirect(accessPath(customerId,'error',`${prefix}: ${clean(error.message||error,300)}`));
      }
    }catch(error){
      return res.redirect(accessPath(customerId,'error',clean(error.message||error,300)||'Could not release this access hold.'));
    }
  });
  return router;
}

module.exports={createAdminCustomerAccessHoldsRouter,MANUAL_RELEASE_TYPES,reconcileCustomerForAdmin,reconcileRoute,forceReconcileRoute,forceReleaseAllHolds,matchingBanScope,banCustomer,unbanCustomer};
