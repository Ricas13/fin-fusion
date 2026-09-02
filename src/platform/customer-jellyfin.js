'use strict';

const express=require('express');
const customers=require('../customers');
const provisioning=require('../jellyfin/resilient-provisioning');
const subscriptionState=require('../entitlements/subscription-state');
const runtimeSettings=require('./runtime-settings');
const customerNav=require('./customer-nav-html');
const csrf=require('../auth/csrf');

function requireCustomer(req,res,next){
  if(req.session?.customerId&&req.session?.customerUserId)return next();
  return res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/jellyfin'));
}
function entitlementName(entitlement){return entitlement?.contract_plan_name||entitlement?.plan_name||entitlement?.name||entitlement?.contract_plan_code||entitlement?.code||'Jellyfin access';}
function entitlementStreams(entitlement){const value=Number(entitlement?.streams||0);return Number.isFinite(value)&&value>0?Math.max(1,Math.floor(value)):null;}
function mergeAccount(account,portalAccount,profile,error=null){
  const effective=profile?.effective||null,entitlement=profile?.entitlement||null;
  const available=effective?effective.entitlementRows.filter(row=>row.effective).map(row=>row.name):[];
  const selected=effective?effective.visibleNames:[];
  return{
    id:account.id,
    serverName:account.server_name||'Jellyfin server',
    publicUrl:account.public_url||'',
    username:account.jellyfin_username||'',
    accessLane:account.access_lane||'primary',
    disabled:Boolean(account.disabled||!account.server_enabled),
    passwordSetupRequired:Boolean(account.password_setup_required),
    canRename:Boolean(portalAccount?.can_rename_jellyfin_username),
    planName:entitlementName(entitlement),
    streams:entitlementStreams(entitlement),
    availableLibraries:available,
    selectedLibraries:selected,
    librarySelectionSaved:Boolean(effective?.selection),
    libraryError:error?String(error.message||error):null
  };
}
async function jellyfinAccountsForCustomer(customerId,portal){
  const portalAccounts=new Map((Array.isArray(portal?.accounts)?portal.accounts:[]).map(account=>[String(account.id),account]));
  const accounts=await provisioning.normalAccounts(customerId),result=[];
  for(const account of accounts){
    try{
      const profile=await provisioning.libraryPolicyForAccount(customerId,account);
      result.push(mergeAccount(account,portalAccounts.get(String(account.id)),profile));
    }catch(error){
      console.warn('Customer Jellyfin hub library profile unavailable:',{customerId,accountId:account.id,error:error.message});
      result.push(mergeAccount(account,portalAccounts.get(String(account.id)),null,error));
    }
  }
  return result;
}
async function currentJellyfinAccess(customerId){
  const [primary,free]=await Promise.all([
    provisioning.currentEntitlement(customerId).catch(()=>null),
    subscriptionState.liveFreeJellyfinSubscription(customerId,{includeBlocked:true}).catch(()=>null)
  ]);
  return Boolean((primary&&!primary.blocked)|| (free&&!free.blocked));
}
function createCustomerJellyfinRouter(){
  const router=express.Router();
  router.get('/account/jellyfin',requireCustomer,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const customerId=req.session.customerId,portal=await customers.getCustomerPortal(customerId);
      const [accounts,entitled]=await Promise.all([jellyfinAccountsForCustomer(customerId,portal),currentJellyfinAccess(customerId)]);
      if(!accounts.length&&!entitled)return res.redirect('/account?error='+encodeURIComponent('You do not currently have Jellyfin access.'));
      res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');
      return res.render('customer/jellyfin',{
        siteName:runtimeSettings.siteName(),portal,accounts,entitled,
        navOptions:customerNav.optionsFromPortal(portal),csrfToken:csrf.token(req),
        message:req.query.message||null,error:req.query.error||null
      });
    }catch(error){return next(error);}
  });
  return router;
}

module.exports={createCustomerJellyfinRouter,jellyfinAccountsForCustomer,mergeAccount,currentJellyfinAccess};
