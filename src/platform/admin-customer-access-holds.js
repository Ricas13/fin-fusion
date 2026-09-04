'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const accessHolds=require('../entitlements/access-holds');
const provisioning=require('../jellyfin/resilient-provisioning');

const MANUAL_RELEASE_TYPES=new Set(['inactivity_policy','jellyfin_cleanup','admin_disabled','admin_suspended','admin_hold','legacy']);

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function accessPath(customerId,key,message){return `/admin/users/${encodeURIComponent(customerId)}?tab=access&${encodeURIComponent(key)}=${encodeURIComponent(message)}`;}
function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}

async function reconcileCustomerForAdmin(customerId,actorUserId){
  const outcome=await provisioning.reconcileCustomer(customerId);
  const blockers=Array.isArray(outcome?.blockers)?outcome.blockers:[];
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.service.reconcile','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({status:outcome?.status||null,active:Boolean(outcome?.active),blockers:blockers.map(row=>({type:row.type,sourceKey:row.sourceKey||null}))})]);
  return outcome;
}

async function forceReleaseAllHolds(customerId,actorUserId,client=null){
  const execute=async db=>{
    const released=await db.query(`
      UPDATE customer_access_holds
      SET released_at=NOW(),released_by=$2
      WHERE customer_id=$1 AND released_at IS NULL
      RETURNING id,hold_type,source_key
    `,[customerId,actorUserId]);
    await accessHolds.syncLegacySummary(customerId,db);
    await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.customer.break_glass.clear_all_holds','customer',$2,$3::jsonb)`,[
        actorUserId,customerId,JSON.stringify({released:released.rowCount,holds:released.rows.map(row=>({id:row.id,type:row.hold_type,sourceKey:row.source_key||null}))})
      ]);
    return released.rows;
  };
  if(client)return execute(client);
  return transaction(execute);
}

async function forceAccessOn(customerId,subscriptionId,actorUserId){
  let released=[];
  await transaction(async client=>{
    const selected=await client.query(`
      SELECT s.id,s.plan_id,COALESCE(p.is_addon,FALSE) is_addon,
             COALESCE(s.plan_name_snapshot,p.name) plan_name
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      WHERE s.id=$1 AND s.customer_id=$2
      FOR UPDATE
    `,[subscriptionId,customerId]);
    if(!selected.rowCount)throw new Error('That subscription does not belong to this customer.');
    if(selected.rows[0].is_addon)throw new Error('Break-glass access must pin a primary plan, not an add-on.');
    released=await forceReleaseAllHolds(customerId,actorUserId,client);
    await client.query(`
      INSERT INTO customer_entitlement_overrides(customer_id,subscription_id,permanent_access,reason,created_by,updated_by,created_at,updated_at,revoked_at,revoked_by)
      VALUES($1,$2,TRUE,'Break-glass administrator override',$3,$3,NOW(),NOW(),NULL,NULL)
      ON CONFLICT(customer_id) DO UPDATE
      SET subscription_id=EXCLUDED.subscription_id,
          permanent_access=TRUE,
          reason=EXCLUDED.reason,
          updated_by=EXCLUDED.updated_by,
          updated_at=NOW(),
          revoked_at=NULL,
          revoked_by=NULL
    `,[customerId,subscriptionId,actorUserId]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.customer.break_glass.force_access_on','customer',$2,$3::jsonb)`,[
        actorUserId,customerId,JSON.stringify({subscriptionId,planName:selected.rows[0].plan_name||null,releasedHolds:released.length})
      ]);
  });
  return{released};
}

async function returnToAutomation(customerId,actorUserId){
  const result=await query(`
    UPDATE customer_entitlement_overrides
    SET permanent_access=FALSE,revoked_at=NOW(),revoked_by=$2,updated_by=$2,updated_at=NOW()
    WHERE customer_id=$1 AND permanent_access=TRUE AND revoked_at IS NULL
    RETURNING subscription_id
  `,[customerId,actorUserId]);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,'admin.customer.break_glass.return_to_automation','customer',$2,$3::jsonb)`,[
      actorUserId,customerId,JSON.stringify({revokedOverride:Boolean(result.rowCount),subscriptionId:result.rows[0]?.subscription_id||null})
    ]);
  return Boolean(result.rowCount);
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

async function reconcileAfterBreakGlass(res,customerId,actorUserId,successMessage){
  try{
    await reconcileCustomerForAdmin(customerId,actorUserId);
    return res.redirect(accessPath(customerId,'message',successMessage));
  }catch(error){
    console.error('Break-glass reconciliation failed:',{customerId,error:error.message});
    return res.redirect(accessPath(customerId,'error',`${successMessage} Reconciliation then failed: ${clean(error.message||error,300)}. The override change itself was kept; retry reconciliation when the external service is ready.`));
  }
}

function createAdminCustomerAccessHoldsRouter(){
  const router=express.Router();
  router.use('/admin/users',gate,noStore);
  // Two route spellings remain for compatibility, but both are thin wrappers
  // over the same service-aware reconciliation owner. This router is mounted
  // before the legacy customer-management router, so its older duplicate route
  // cannot trigger a second Stremio reconciliation.
  router.post('/admin/users/:customerId/manage/reconcile',reconcileRoute);
  router.post('/admin/users/:customerId/reconcile',reconcileRoute);

  // Break-glass actions are deliberately stronger than the normal workflow.
  // They remain admin-only, CSRF-protected and audited, but they do not defer to
  // payment-risk or specialized hold ownership. Their purpose is to let an
  // administrator recover a customer when automation cannot converge.
  router.post('/admin/users/:customerId/manage/force/clear-blockers',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId;
    try{
      const released=await forceReleaseAllHolds(customerId,req.session.authUserId);
      return reconcileAfterBreakGlass(res,customerId,req.session.authUserId,`Break-glass override cleared ${released.length} active blocker${released.length===1?'':'s'}.`);
    }catch(error){
      return res.redirect(accessPath(customerId,'error',`Could not clear blockers: ${clean(error.message||error,300)}`));
    }
  });
  router.post('/admin/users/:customerId/manage/force/access-on',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId,subscriptionId=clean(req.body.subscriptionId,80);
    try{
      if(!subscriptionId)throw new Error('Choose the subscription/plan that should own forced access.');
      const result=await forceAccessOn(customerId,subscriptionId,req.session.authUserId);
      return reconcileAfterBreakGlass(res,customerId,req.session.authUserId,`FORCED ACCESS is now pinned to the selected plan. ${result.released.length} blocker${result.released.length===1?' was':'s were'} cleared.`);
    }catch(error){
      return res.redirect(accessPath(customerId,'error',`Could not force access on: ${clean(error.message||error,300)}`));
    }
  });
  router.post('/admin/users/:customerId/manage/force/automation',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId;
    try{
      const changed=await returnToAutomation(customerId,req.session.authUserId);
      return reconcileAfterBreakGlass(res,customerId,req.session.authUserId,changed?'Break-glass access override removed. Normal entitlement automation is authoritative again.':'No active break-glass entitlement override existed; normal automation remains authoritative.');
    }catch(error){
      return res.redirect(accessPath(customerId,'error',`Could not return to automation: ${clean(error.message||error,300)}`));
    }
  });

  router.post('/admin/users/:customerId/access-holds/:holdId/release',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId,holdId=String(req.params.holdId||'').trim();
    try{
      if(String(req.body.confirmation||'').trim().toUpperCase()!=='RELEASE')throw new Error('Type RELEASE to confirm this access change.');
      const resolutionReason=clean(req.body.reason,500);
      if(resolutionReason.length<5)throw new Error('Enter a release reason of at least 5 characters for the audit trail.');
      let releasedType='';
      await transaction(async client=>{
        const selected=await client.query(`SELECT * FROM customer_access_holds WHERE id=$1 AND customer_id=$2 AND released_at IS NULL FOR UPDATE`,[holdId,customerId]);
        if(!selected.rowCount)throw new Error('This hold is no longer active. Refresh the customer page.');
        const hold=selected.rows[0],type=String(hold.hold_type||'');
        if(type==='payment_risk')throw new Error('Payment-risk holds can only be released through the payment incident workflow after provider verification.');
        if(!MANUAL_RELEASE_TYPES.has(type))throw new Error(`The ${type||'unknown'} hold is owned by a specialized workflow and cannot be released here.`);
        const count=await accessHolds.releaseHold({customerId,type,sourceKey:hold.source_key,actorUserId:req.session.authUserId,resolutionReason},client);
        if(count!==1)throw new Error('The hold changed before it could be released. Refresh and try again.');
        releasedType=type;
      });
      try{
        const outcome=await reconcileCustomerForAdmin(customerId,req.session.authUserId);
        const remaining=Array.isArray(outcome?.blockers)?outcome.blockers.length:0;
        const message=remaining
          ? `Access hold released. ${remaining} other active hold${remaining===1?' remains':'s remain'}, so access is still restricted.`
          : 'Access hold released and service access reconciled against the current entitlement.';
        return res.redirect(accessPath(customerId,'message',message));
      }catch(error){
        console.error('Customer hold release reconciliation failed:',{customerId,holdId,holdType:releasedType,error:error.message});
        return res.redirect(accessPath(customerId,'error',`The hold was released, but service reconciliation failed: ${clean(error.message||error,300)}`));
      }
    }catch(error){
      return res.redirect(accessPath(customerId,'error',clean(error.message||error,300)||'Could not release this access hold.'));
    }
  });
  return router;
}

module.exports={createAdminCustomerAccessHoldsRouter,MANUAL_RELEASE_TYPES,reconcileCustomerForAdmin,reconcileRoute,forceReleaseAllHolds,forceAccessOn,returnToAutomation};