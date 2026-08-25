'use strict';
const express=require('express');
const {pool}=require('../db');
const runtimeSettings=require('./runtime-settings');
const operations=require('./operations-settings');
const customers=require('../customers');
const referrals=require('../referrals');
const customerSecurity=require('./customer-security');
const customerNav=require('./customer-nav-html');

function safeNext(input){const value=String(input||'').trim();return value.startsWith('/account')&&!value.startsWith('//')?value:'/account/affiliate';}
function positiveInt(v){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function createRouter(){
 const router=express.Router();
 router.use(customerSecurity.requireCustomer);
 router.get('/account/affiliate',async(req,res)=>{
  try{
   await runtimeSettings.ensureLoaded();
   const customerId=req.session.customerId;
   const portal=await customers.getCustomerPortal(customerId);
   if(!portal.referralsEnabled)return res.redirect('/account?error=Benefits+are+not+available');
   const code=portal.referralCode;
   const referralLink=await operations.absoluteUrl(req,'/account/register?ref='+encodeURIComponent(code));
   const [stats,earnings,balances,ledger,payouts]=await Promise.all([
    referrals.referrerStats(customerId),
    referrals.earningsSummary(customerId),
    referrals.creditBalances(customerId),
    referrals.listCreditLedger(customerId,{limit:50}),
    referrals.listPayouts(customerId,{limit:50})
   ]);
   return res.render('customer/affiliate',{
    siteName:runtimeSettings.siteName(),csrfToken:req.csrfToken(),portal,code,referralLink,stats,
    earnings,balances,ledger,payouts,navOptions:customerNav.optionsFromPortal(portal),message:req.query.message||'',error:req.query.error||''
   });
  }catch(err){
   req.log?.error?.(err);
   return res.status(500).send('Request failed.');
  }
 });
 router.post('/account/affiliate/payouts',async(req,res)=>{
  const next=safeNext(req.body.next);
  try{
   const customerId=req.session.customerId;
   const amountMinor=positiveInt(req.body.amount_minor);
   const currency=String(req.body.currency||'USD').toUpperCase();
   const method=String(req.body.method||'').trim();
   if(!amountMinor||!method)throw new Error('Enter a payout amount and method.');
   await referrals.requestPayout({customerId,currency,amountMinor,method,note:String(req.body.note||'').trim()||null});
   return res.redirect(next+'?message='+encodeURIComponent('Payout request submitted.'));
  }catch(err){return res.redirect(next+'?error='+encodeURIComponent(err.message));}
 });
 router.post('/account/affiliate/credit/apply',async(req,res)=>{
  const next=safeNext(req.body.next);
  try{
   const customerId=req.session.customerId;
   const amountMinor=positiveInt(req.body.amount_minor);
   const currency=String(req.body.currency||'USD').toUpperCase();
   if(!amountMinor)throw new Error('Enter an amount to apply.');
   const result=await referrals.applyCreditToAccount({customerId,currency,amountMinor});
   return res.redirect(next+'?message='+encodeURIComponent(result.message||'Credit applied.'));
  }catch(err){return res.redirect(next+'?error='+encodeURIComponent(err.message));}
 });
 return router;
}
module.exports=createRouter();
module.exports.createRouter=createRouter;
