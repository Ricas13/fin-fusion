'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const accessHolds=require('../entitlements/access-holds');
const provisioning=require('../jellyfin/resilient-provisioning');
const reconciliationControl=require('../jellyfin/reconciliation-control');

const MANUAL_RELEASE_TYPES=new Set(['inactivity_policy','jellyfin_cleanup','admin_disabled','admin_suspended','admin_hold','legacy']);

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function accessPath(customerId,key,message){return `/admin/users/${encodeURIComponent(customerId)}?tab=access&${encodeURIComponent(key)}=${encodeURIComponent(message)}`;}
function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}

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

module.exports={createAdminCustomerAccessHoldsRouter,MANUAL_RELEASE_TYPES,reconcileCustomerForAdmin,reconcileRoute,forceReconcileRoute,forceReleaseAllHolds};