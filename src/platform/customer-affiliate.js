'use strict';

const express=require('express');
const customers=require('../customers');
const affiliateCredits=require('../affiliate-credits');
const planPricing=require('../payments/plan-pricing');
const serviceCreditReservations=require('../payments/service-credit-reservations');
const runtimeSettings=require('./runtime-settings');
const operations=require('./operations-settings');
const customerNav=require('./customer-nav-html');
const csrf=require('../auth/csrf');

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/affiliate'));}
async function plansFor(currency){const logical=await customers.listPublicPlans();return planPricing.decoratePlans(logical,currency,{allowFallback:false});}

function createCustomerAffiliateRouter(){
  const r=express.Router();
  r.get('/account/affiliate',requireCustomer,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const settings=await affiliateCredits.loadSettings();
      if(!settings.enabled)return res.redirect('/account?error='+encodeURIComponent('The affiliate program is not currently available.'));
      const enrolled=await affiliateCredits.enroll(req.session.customerId);
      await affiliateCredits.matureDueCredits(req.session.customerId);
      const currency=planPricing.cleanCurrency(req.query.currency||await planPricing.userPreferredCurrency(req.session.customerUserId),'GBP');
      const referralLink=await operations.absoluteUrl(req,'/account/register?ref='+encodeURIComponent(enrolled.code));
      const [rawState,plans,portal]=await Promise.all([affiliateCredits.profile(req.session.customerId),plansFor(currency),customers.getCustomerPortal(req.session.customerId)]);
      const balances=await Promise.all((rawState.balances||[]).map(async balance=>({...balance,available_minor:await serviceCreditReservations.availableMinor(req.session.customerId,balance.currency)})));
      const state={...rawState,balances};
      return res.render('customer/affiliate',{siteName:runtimeSettings.siteName(),settings,code:enrolled.code,referralLink,state,plans,currency,currencies:await planPricing.enabledCurrencies(),navOptions:customerNav.optionsFromPortal(portal),csrfToken:csrf.token(req),message:req.query.message||null,error:req.query.error||null});
    }catch(error){next(error);}
  });
  r.post('/account/affiliate/redeem',requireCustomer,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const result=await affiliateCredits.redeemPlan({customerId:req.session.customerId,planCode:req.body.planCode,currency:req.body.currency});
      return res.redirect('/account?message='+encodeURIComponent(`Service credit redeemed. Your ${result.currency} credit-funded subscription is active.`));
    }catch(error){return res.redirect('/account/affiliate?currency='+encodeURIComponent(req.body.currency||'GBP')+'&error='+encodeURIComponent(error.message));}
  });
  return r;
}

module.exports={createCustomerAffiliateRouter};
