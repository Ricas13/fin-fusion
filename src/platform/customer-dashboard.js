'use strict';
const express=require('express');
const {query}=require('../db');
const customers=require('../customers');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const provisioning=require('../jellyfin/resilient-provisioning');
const customerInactivity=require('../automation/customer-inactivity');
const requestUserSync=require('../integrations/request-user-sync');
const runtimeSettings=require('./runtime-settings');
const productReadiness=require('./product-readiness');
const planCapacity=require('../entitlements/plan-capacity');
const csrf=require('../auth/csrf');

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'));}
async function hideInternalAccounts(customerId,portal){
  if(!portal||!Array.isArray(portal.accounts)||!portal.accounts.length)return portal;
  const hidden=await query(`SELECT id FROM jellyfin_accounts WHERE customer_id=$1 AND account_purpose='stremio_internal'`,[customerId]),ids=new Set(hidden.rows.map(row=>String(row.id)));
  portal.accounts=portal.accounts.filter(account=>!ids.has(String(account.id)));
  return portal;
}
function deliveryType(entitlement){return productReadiness.serviceType({service_type:entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin'});}
async function sellablePlans(){
  const rows=await customers.listPublicPlans(),ctx=await productReadiness.context(),ready=rows.filter(plan=>productReadiness.evaluate(plan,ctx).sellable);
  const capacityStates=await Promise.all(ready.map(plan=>planCapacity.usage(plan.id).catch(()=>({soldOut:false}))));
  return ready.filter((_plan,index)=>!capacityStates[index].soldOut);
}
function onboardingMessage(portal,currentPlan,delivery){
  if(!currentPlan||!['jellyfin','bundle'].includes(delivery)||!Array.isArray(portal.accounts))return null;
  const account=portal.accounts.find(a=>a.is_primary&&!a.disabled)||portal.accounts.find(a=>!a.disabled);
  if(!account||account.disabled||account.last_activity_at)return null;
  const username=account.jellyfin_username||portal.customer?.login_username||'your Jellyfin username';
  if(account.password_setup_required)return `Your Jellyfin access is ready. 1) Open “Jellyfin access” below and set your Jellyfin password. 2) Use the Open Jellyfin button. 3) Sign in as ${username}. 4) Start any title to confirm the setup. These instructions stay here until your first playback is detected.`;
  return `Your Jellyfin access is ready. 1) Use the Open Jellyfin button below. 2) Sign in as ${username} with the Jellyfin password you set. 3) Start any title to confirm the setup. These instructions stay here until your first playback is detected.`;
}
function createCustomerDashboardRouter(){
  const r=express.Router();
  r.get('/account',requireCustomer,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      // A global dormant-user cleanup never removes the CAPTaINFiN customer.
      // Returning to the portal is an explicit signal that an entitled customer
      // wants service again, so release only the cleanup hold and reprovision.
      const restored=await customerInactivity.restoreReturningCustomer(req.session.customerId).catch(error=>({restored:false,error:error.message}));
      const [portalRaw,plans,currentPlan,requestAccess,requestConfig]=await Promise.all([
        customers.getCustomerPortal(req.session.customerId),sellablePlans(),provisioning.currentEntitlement(req.session.customerId),requestUserSync.requestAccessForCustomer(req.session.customerId),requestUserSync.configuration()
      ]);
      const portal=await hideInternalAccounts(req.session.customerId,portalRaw),delivery=deliveryType(currentPlan),hasJellyfin=['jellyfin','bundle'].includes(delivery),hasStremio=['stremio','bundle'].includes(delivery);
      const restoreMessage=restored.restored?'Your inactive Jellyfin user was cleaned up previously. A fresh Jellyfin account has now been provisioned because you returned to your CAPTaINFiN account.':null;
      if(delivery==='stremio'){
        return res.render('customer/stremio-dashboard',{portal,plans,currentPlan,stripeEnabled:stripe.enabled(),paypalEnabled:paypal.enabled(),csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message:req.query.message||restoreMessage||null,error:req.query.error||restored.error||null});
      }
      const effective=currentPlan&&hasJellyfin?await provisioning.effectivePolicyForCustomer(req.session.customerId,currentPlan):null;
      const libraryEntitlement=effective?effective.entitlementRows.filter(row=>row.effective).map(row=>row.name):[],librarySelection=effective?effective.visibleNames:[];
      const welcome=onboardingMessage(portal,currentPlan,delivery),message=req.query.message||restoreMessage||welcome||((hasStremio&&delivery==='bundle')?'Your plan also includes Stremio. Open /account/stremio to create or manage your private installation.':null);
      return res.render('customer/dashboard',{portal,plans,currentPlan,stripeEnabled:stripe.enabled(),paypalEnabled:paypal.enabled(),overseerrUrl:runtimeSettings.overseerrUrl(),requestAccess,requestSyncConfigured:requestConfig.configured,libraryEntitlement,librarySelection,csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message,error:req.query.error||restored.error||null,deliveryType:delivery,hasJellyfin,hasStremio});
    }catch(error){return next(error);}
  });
  return r;
}
module.exports={createCustomerDashboardRouter,hideInternalAccounts,deliveryType,sellablePlans,onboardingMessage};
