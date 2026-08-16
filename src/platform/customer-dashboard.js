'use strict';

const express=require('express');
const {query}=require('../db');
const customers=require('../customers');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const provisioning=require('../jellyfin/resilient-provisioning');
const requestUserSync=require('../integrations/request-user-sync');
const runtimeSettings=require('./runtime-settings');
const policy=require('../jellyfin/policy');
const csrf=require('../auth/csrf');

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'));}
async function hideInternalAccounts(customerId,portal){
  if(!portal||!Array.isArray(portal.accounts)||!portal.accounts.length)return portal;
  const hidden=await query(`SELECT id FROM jellyfin_accounts WHERE customer_id=$1 AND account_purpose='stremio_internal'`,[customerId]),ids=new Set(hidden.rows.map(row=>String(row.id)));
  portal.accounts=portal.accounts.filter(account=>!ids.has(String(account.id)));
  return portal;
}
function createCustomerDashboardRouter(){
  const r=express.Router();
  r.get('/account',requireCustomer,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const [portalRaw,plans,currentPlan,requestAccess,requestConfig]=await Promise.all([
        customers.getCustomerPortal(req.session.customerId),customers.listPublicPlans(),provisioning.currentEntitlement(req.session.customerId),requestUserSync.requestAccessForCustomer(req.session.customerId),requestUserSync.configuration()
      ]);
      const portal=await hideInternalAccounts(req.session.customerId,portalRaw),effective=currentPlan?await provisioning.effectivePolicyForCustomer(req.session.customerId,currentPlan):null;
      const libraryEntitlement=effective?effective.entitlementRows.filter(row=>row.effective).map(row=>row.name):[],librarySelection=effective?effective.visibleNames:[];
      return res.render('customer/dashboard',{portal,plans,currentPlan,stripeEnabled:stripe.enabled(),paypalEnabled:paypal.enabled(),overseerrUrl:runtimeSettings.overseerrUrl(),requestAccess,requestSyncConfigured:requestConfig.configured,libraryEntitlement,librarySelection,csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message:req.query.message||null,error:req.query.error||null});
    }catch(error){return next(error);}
  });
  return r;
}
module.exports={createCustomerDashboardRouter,hideInternalAccounts};
