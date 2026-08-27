'use strict';

const express=require('express');
const provisioning=require('../jellyfin/resilient-provisioning');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');

const librarySelectionLimit=routeRateLimit.middleware({scope:'customer-library-selection',max:20,windowSeconds:300});

function requireCustomer(req,res,next){
  if(req.session?.customerId&&req.session?.customerUserId)return next();
  return res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'));
}

async function saveLibraries(req,res,accountId){
  if(!csrf.verify(req))return res.redirect('/account?error='+encodeURIComponent('Invalid or expired security token')+'#jellyfin-access');
  try{
    let target=String(accountId||req.body.accountId||'').trim();
    if(!target){
      const accounts=(await provisioning.normalAccounts(req.session.customerId)).filter(account=>!account.disabled&&account.server_enabled);
      if(accounts.length!==1)throw new Error('Choose the Jellyfin server whose libraries you want to update.');
      target=String(accounts[0].id);
    }
    const submitted=Array.isArray(req.body.library)?req.body.library:(req.body.library!==undefined?[req.body.library]:[]);
    const chosen=await provisioning.setLibrarySelectionForAccount(req.session.customerId,target,submitted);
    try{
      await provisioning.reconcileCustomer(req.session.customerId);
    }catch(reconcileError){
      console.warn('Customer library selection saved but Jellyfin reconciliation failed:',{
        customerId:req.session.customerId,
        accountId:target,
        error:reconcileError.message
      });
      return res.redirect('/account?error='+encodeURIComponent('Library selection was saved, but Jellyfin could not be updated right now. Use Retry setup or try again later.')+'#jellyfin-access');
    }
    return res.redirect('/account?message='+encodeURIComponent(`Library visibility updated for this Jellyfin server (${chosen.length} selected).`)+'#jellyfin-access');
  }catch(error){
    return res.redirect('/account?error='+encodeURIComponent(error.message||'Library visibility could not be updated safely.')+'#jellyfin-access');
  }
}

function createCustomerLibrarySelectionRouter(){
  const router=express.Router();
  router.post('/account/libraries',requireCustomer,librarySelectionLimit,(req,res)=>saveLibraries(req,res,null));
  router.post('/account/libraries/:accountId',requireCustomer,librarySelectionLimit,(req,res)=>saveLibraries(req,res,req.params.accountId));
  return router;
}

module.exports={createCustomerLibrarySelectionRouter,saveLibraries};
