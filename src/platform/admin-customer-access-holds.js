'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const accessControl=require('../access/admin-customer-access-control');

const {MANUAL_RELEASE_TYPES}=accessControl;

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function accessPath(customerId,key,message){return `/admin/users/${encodeURIComponent(customerId)}?tab=access&${encodeURIComponent(key)}=${encodeURIComponent(message)}`;}
function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}

const reconcileCustomerForAdmin=accessControl.reconcileCustomerForAdmin;
const forceReleaseAllHolds=accessControl.forceReleaseAllHolds;
const matchingBanScope=accessControl.matchingBanScope;
const banCustomer=accessControl.banCustomer;
const unbanCustomer=accessControl.unbanCustomer;

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
      const result=await accessControl.releaseCustomerHold(customerId,holdId,req.session.authUserId,resolutionReason);
      if(result.restoredInactivity){
        return res.redirect(accessPath(customerId,'message','Free Server inactivity removal was cleared and Free access was restored.'));
      }
      const remaining=Number(result.remainingBlockers||0);
      const message=remaining
        ? `Access hold released. ${remaining} other active hold${remaining===1?' remains':'s remain'}, so access is still restricted.`
        : 'Access hold released and service access reconciled against the current entitlement.';
      return res.redirect(accessPath(customerId,'message',message));
    }catch(error){
      if(error?.holdReleaseCommitted||error?.inactivityRestoreFailed){
        console.error('Customer hold release reconciliation failed:',{customerId,holdId,holdType:error.releasedType||'',sourceKey:error.selectedSourceKey||'',error:error.message});
        const prefix=error.inactivityRestoreFailed?'Free Server access was not restored':'The hold was released, but service reconciliation failed';
        return res.redirect(accessPath(customerId,'error',`${prefix}: ${clean(error.message||error,300)}`));
      }
      return res.redirect(accessPath(customerId,'error',clean(error.message||error,300)||'Could not release this access hold.'));
    }
  });
  return router;
}

module.exports={createAdminCustomerAccessHoldsRouter,MANUAL_RELEASE_TYPES,reconcileCustomerForAdmin,reconcileRoute,forceReconcileRoute,forceReleaseAllHolds,matchingBanScope,banCustomer,unbanCustomer};
