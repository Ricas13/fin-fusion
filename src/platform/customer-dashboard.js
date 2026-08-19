'use strict';
const express=require('express');
const {query}=require('../db');
const customers=require('../customers');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const planPricing=require('../payments/plan-pricing');
const provisioning=require('../jellyfin/resilient-provisioning');
const permanentAccess=require('../entitlements/permanent-access');
const cleanupReturn=require('../entitlements/jellyfin-cleanup-return');
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
async function sellablePlans(currency='GBP'){
  const logical=await customers.listPublicPlans(),rows=await planPricing.decoratePlans(logical,currency),ctx=await productReadiness.context(),ready=rows.filter(plan=>productReadiness.evaluate(plan,ctx).sellable);
  const capacityStates=await Promise.all(ready.map(plan=>planCapacity.usage(plan.id).catch(()=>({limit:plan.capacity_limit??null,used:0,reserved:0,remaining:plan.capacity_limit??null,soldOut:false}))));
  return ready.map((plan,index)=>({...plan,capacity:capacityStates[index]})).filter(plan=>plan.is_free_tier||!plan.capacity.soldOut);
}
function onboardingMessage(portal,currentPlan,delivery){
  if(!currentPlan||!['jellyfin','bundle'].includes(delivery)||!Array.isArray(portal.accounts))return null;
  const account=portal.accounts.find(a=>a.is_primary&&!a.disabled)||portal.accounts.find(a=>!a.disabled);
  if(!account||account.disabled||account.last_activity_at)return null;
  const username=account.jellyfin_username||portal.customer?.login_username||'your Jellyfin username';
  if(account.password_setup_required)return 'Your Jellyfin account is ready. Choose your password below to start watching.';
  return `Your Jellyfin account is ready. Open Jellyfin and sign in as ${username}.`;
}
function customerProvisioningMessage(state){
  const message=String(state?.last_error||'');
  if(/no eligible jellyfin server|no jellyfin server|no suitable server/i.test(message))return 'No suitable Jellyfin server is available for this plan right now. We will retry automatically, or you can retry now.';
  if(/username .* already exists|target_username_exists/i.test(message))return 'That Jellyfin username is already in use on the target server. Please retry; if it continues, contact support.';
  if(/capacity|max_users|sold out/i.test(message))return 'The eligible Jellyfin server is currently at capacity. We will retry automatically when space is available.';
  if(state&&['blocked','failed','pending','running'].includes(String(state.status||'')))return 'Your plan is active, but Jellyfin setup has not completed yet. We will keep retrying automatically.';
  return null;
}
function createCustomerDashboardRouter(){
  const r=express.Router();
  r.get('/account',requireCustomer,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const restored=await cleanupReturn.restoreReturningCustomer(req.session.customerId,{reconcile:provisioning.reconcileCustomer}).catch(error=>({restored:false,error:error.message}));
      const sessionCurrency=String(req.session.storefrontCurrency||'').toUpperCase(),currency=planPricing.CURRENCIES.includes(sessionCurrency)?sessionCurrency:await planPricing.userPreferredCurrency(req.session.customerUserId);
      const [portalRaw,plans,currentPlan,requestAccess,requestConfig,currencies,rawProvisioningState,permanentState]=await Promise.all([
        customers.getCustomerPortal(req.session.customerId),sellablePlans(currency),provisioning.currentEntitlement(req.session.customerId),requestUserSync.requestAccessForCustomer(req.session.customerId),requestUserSync.configuration(),planPricing.enabledCurrencies(),provisioning.control.getCustomerState(req.session.customerId).catch(()=>null),permanentAccess.status(req.session.customerId).catch(()=>null)
      ]);
      const portal=await hideInternalAccounts(req.session.customerId,portalRaw),restoreMessage=restored.restored?'Your previous inactive Jellyfin profile was cleaned up. Because you returned, CAPTAiNFiN has prepared fresh access for you.':null;
      if(!currentPlan){
        return res.render('customer/onboarding',{portal,plans,stripeEnabled:stripe.enabled(),paypalEnabled:paypal.enabled(),currency,currencies,csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message:req.query.message||restoreMessage||null,error:req.query.error||restored.error||null});
      }
      const isPermanent=Boolean(permanentState?.active&&String(permanentState.subscription_id)===String(currentPlan.subscription_id));
      const provisioningState=rawProvisioningState?{...rawProvisioningState,last_error:customerProvisioningMessage(rawProvisioningState)}:null;
      const delivery=deliveryType(currentPlan),hasJellyfin=['jellyfin','bundle'].includes(delivery),hasStremio=['stremio','bundle'].includes(delivery);
      if(delivery==='stremio'){
        return res.render('customer/stremio-dashboard',{portal,plans,currentPlan,stripeEnabled:stripe.enabled(),paypalEnabled:paypal.enabled(),currency,currencies,csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message:req.query.message||restoreMessage||null,error:req.query.error||restored.error||null,permanentAccess:isPermanent});
      }
      const effective=currentPlan&&hasJellyfin?await provisioning.effectivePolicyForCustomer(req.session.customerId,currentPlan):null;
      const libraryEntitlement=effective?effective.entitlementRows.filter(row=>row.effective).map(row=>row.name):[],librarySelection=effective?effective.visibleNames:[];
      const welcome=onboardingMessage(portal,currentPlan,delivery),message=req.query.message||restoreMessage||welcome||((hasStremio&&delivery==='bundle')?'Your plan also includes Stremio. Open Stremio setup to create or manage your private installation.':null);
      return res.render('customer/dashboard',{portal,plans,currentPlan,stripeEnabled:stripe.enabled(),paypalEnabled:paypal.enabled(),currency,currencies,overseerrUrl:runtimeSettings.overseerrUrl(),requestAccess,requestSyncConfigured:requestConfig.configured,libraryEntitlement,librarySelection,provisioningState,csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message,error:req.query.error||restored.error||null,welcome:req.query.welcome==='1',deliveryType:delivery,hasJellyfin,hasStremio,permanentAccess:isPermanent});
    }catch(error){return next(error);}
  });
  r.post('/account/provisioning/retry',requireCustomer,async(req,res)=>{
    if(!csrf.verify(req))return res.redirect('/account?error='+encodeURIComponent('Invalid or expired security token'));
    try{
      const outcome=await provisioning.reconcileCustomer(req.session.customerId);
      if(outcome?.active&&outcome?.account?.id)return res.redirect('/account?welcome=1&message='+encodeURIComponent('Your Jellyfin access is ready.'));
      const state=await provisioning.control.getCustomerState(req.session.customerId).catch(()=>null);
      const safe=customerProvisioningMessage(state)||'Your plan is active, but Jellyfin setup has not completed yet. We will keep retrying automatically.';
      return res.redirect('/account?welcome=1&error='+encodeURIComponent(safe));
    }catch(error){const safe=customerProvisioningMessage({status:'failed',last_error:error?.message||error})||'Your plan is active, but Jellyfin setup is still pending.';return res.redirect('/account?welcome=1&error='+encodeURIComponent(safe));}
  });
  return r;
}
module.exports={createCustomerDashboardRouter,hideInternalAccounts,deliveryType,sellablePlans,onboardingMessage,customerProvisioningMessage};
