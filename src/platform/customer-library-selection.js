'use strict';

const express=require('express');
const {query}=require('../db');
const provisioning=require('../jellyfin/resilient-provisioning');
const libraryPolicy=require('../jellyfin/account-library-policy');
const jellyfinPolicy=require('../jellyfin/policy');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');

const librarySelectionLimit=routeRateLimit.middleware({scope:'customer-library-selection',max:20,windowSeconds:300});

function requireCustomer(req,res,next){
  if(req.session?.customerId&&req.session?.customerUserId)return next();
  return res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'));
}
function jellyfinHubReturn(req){return String(req.body?.returnTo||'')==='jellyfin';}
function successRedirect(req,res,message){return res.redirect((jellyfinHubReturn(req)?'/account/jellyfin?message=':'/account?message=')+encodeURIComponent(message)+(jellyfinHubReturn(req)?'':'#jellyfin-access'));}
function errorRedirect(req,res,message){
  if(jellyfinHubReturn(req))return res.redirect('/account/jellyfin?error='+encodeURIComponent(message));
  return res.redirect('/account?error='+encodeURIComponent(message||'Library visibility could not be updated safely.')+'#jellyfin-access');
}

async function selectEntitledLibraries(customerId,accountId,names){
  const profile=await provisioning.libraryPolicyForAccount(customerId,accountId);
  if(!profile.entitlement||profile.entitlement.blocked||!profile.effective)throw new Error('This Jellyfin account does not have current library access.');
  const entitled=new Map(profile.effective.entitlementRows.filter(row=>row.effective).map(row=>[jellyfinPolicy.nameKey(row.name),row.name]));
  const chosen=[];
  for(const raw of Array.isArray(names)?names:[]){
    const match=entitled.get(jellyfinPolicy.nameKey(raw));
    if(match&&!chosen.includes(match))chosen.push(match);
  }
  await libraryPolicy.setScopedSelection(customerId,accountId,chosen);
  return chosen;
}

async function saveLibraries(req,res,accountId){
  if(!csrf.verify(req))return errorRedirect(req,res,'Invalid or expired security token');
  try{
    let target=String(accountId||req.body.accountId||'').trim();
    if(!target){
      const accounts=(await provisioning.normalAccounts(req.session.customerId)).filter(account=>!account.disabled&&account.server_enabled);
      if(accounts.length!==1)throw new Error('Choose the Jellyfin server whose libraries you want to update.');
      target=String(accounts[0].id);
    }
    const submitted=Array.isArray(req.body.library)?req.body.library:(req.body.library!==undefined?[req.body.library]:[]);
    const chosen=await selectEntitledLibraries(req.session.customerId,target,submitted);
    await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('customer.jellyfin.library_visibility','customer',$1,$2::jsonb)`,[
      req.session.customerId,JSON.stringify({accountId:target,selectedCount:chosen.length,selectedNames:chosen})
    ]).catch(error=>console.warn('Customer Jellyfin library visibility audit failed:',error.message));
    try{
      await provisioning.reconcileCustomer(req.session.customerId);
    }catch(reconcileError){
      console.warn('Customer library selection saved but Jellyfin reconciliation failed:',{
        customerId:req.session.customerId,
        accountId:target,
        error:reconcileError.message
      });
      return errorRedirect(req,res,'Library selection was saved, but Jellyfin could not be updated right now. Use Retry setup or try again later.');
    }
    return successRedirect(req,res,`Library visibility updated (${chosen.length} selected).`);
  }catch(error){
    if(jellyfinHubReturn(req))return res.redirect('/account/jellyfin?error='+encodeURIComponent(error.message||'Library visibility could not be updated safely.'));
    return res.redirect('/account?error='+encodeURIComponent(error.message||'Library visibility could not be updated safely.')+'#jellyfin-access');
  }
}

function createCustomerLibrarySelectionRouter(){
  const router=express.Router();
  router.post('/account/libraries',requireCustomer,librarySelectionLimit,(req,res)=>saveLibraries(req,res,null));
  router.post('/account/libraries/:accountId',requireCustomer,librarySelectionLimit,(req,res)=>saveLibraries(req,res,req.params.accountId));
  return router;
}

module.exports={createCustomerLibrarySelectionRouter,saveLibraries,selectEntitledLibraries,jellyfinHubReturn};
