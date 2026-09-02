'use strict';

const express=require('express');
const customers=require('../customers');
const provisioning=require('../jellyfin/resilient-provisioning');
const subscriptionState=require('../entitlements/subscription-state');
const runtimeSettings=require('./runtime-settings');
const customerNav=require('./customer-nav-html');
const requestUsers=require('../integrations/request-user-sync');
const routeRateLimit=require('../security/route-rate-limit');
const csrf=require('../auth/csrf');
const {query}=require('../db');

const mediaMutationLimit=routeRateLimit.middleware({scope:'customer-access-media-credentials',max:10,windowSeconds:900});
const requestPasswordLimit=routeRateLimit.middleware({scope:'customer-access-request-password',max:10,windowSeconds:900});

function requireCustomer(req,res,next){
  if(req.session?.customerId&&req.session?.customerUserId)return next();
  return res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/access'));
}
function entitlementName(entitlement){return entitlement?.contract_plan_name||entitlement?.plan_name||entitlement?.name||entitlement?.contract_plan_code||entitlement?.code||'Streaming access';}
function entitlementStreams(entitlement){const value=Number(entitlement?.streams||0);return Number.isFinite(value)&&value>0?Math.max(1,Math.floor(value)):null;}
function mediaType(account){return String(account?.media_server_type||'jellyfin').toLowerCase()==='emby'?'emby':'jellyfin';}
function mediaLabel(account){return mediaType(account)==='emby'?'Emby':'Jellyfin';}
function accessLabel(account){if(mediaType(account)==='emby')return'Emby Share';return String(account?.access_lane||'primary')==='free'?'Free Server':'Premium Jellyfin';}
function redirectAccess(res,key,message,hash=''){
  const params=new URLSearchParams();
  params.set(key,String(message||''));
  return res.redirect('/account/access?'+params.toString()+(hash?'#'+encodeURIComponent(hash):''));
}
function legacyAccessRedirect(req,res){
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(req.query||{})){
    if(Array.isArray(value))value.forEach(item=>params.append(key,String(item)));
    else if(value!==undefined&&value!==null)params.set(key,String(value));
  }
  const queryString=params.toString();
  return res.redirect(302,'/account/access'+(queryString?'?'+queryString:''));
}

async function mediaRows(customerId){
  const result=await query(`
    SELECT ja.*,js.enabled AS server_enabled,js.server_class,js.name AS server_name,js.public_url,
           COALESCE(js.media_server_type,'jellyfin') AS media_server_type
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.customer_id=$1 AND ja.account_purpose<>'stremio_internal'
    ORDER BY CASE COALESCE(js.media_server_type,'jellyfin') WHEN 'jellyfin' THEN 0 ELSE 1 END,
             CASE ja.access_lane WHEN 'free' THEN 0 ELSE 1 END,
             ja.is_primary DESC,ja.disabled ASC,ja.created_at ASC
  `,[customerId]);
  return result.rows;
}

async function entitlementForAccount(customerId,account){
  if(!account)return null;
  if(mediaType(account)==='emby')return subscriptionState.effectiveEmbySubscription(customerId,{includeBlocked:true}).catch(()=>null);
  if(String(account.access_lane||'primary')==='free')return subscriptionState.liveFreeJellyfinSubscription(customerId,{includeBlocked:true}).catch(()=>null);
  const current=await provisioning.currentEntitlement(customerId).catch(()=>null);
  return current&&!current.is_free_tier?current:null;
}

function mergeAccount(account,portalAccount,profile,entitlement,error=null){
  const effective=profile?.effective||null;
  const available=effective?effective.entitlementRows.filter(row=>row.effective).map(row=>row.name):[];
  const selected=effective?effective.visibleNames:[];
  const type=mediaType(account);
  return{
    id:account.id,
    serviceType:type,
    serviceLabel:mediaLabel(account),
    accessLabel:accessLabel(account),
    serverName:account.server_name||`${mediaLabel(account)} server`,
    publicUrl:account.public_url||'',
    username:account.jellyfin_username||'',
    accessLane:account.access_lane||'primary',
    disabled:Boolean(account.disabled||!account.server_enabled||entitlement?.blocked),
    passwordSetupRequired:Boolean(account.password_setup_required),
    canRename:Boolean(portalAccount?.can_rename_jellyfin_username),
    planName:entitlementName(entitlement),
    streams:entitlementStreams(entitlement),
    subscriptionId:entitlement?.subscription_id||null,
    availableLibraries:available,
    selectedLibraries:selected,
    librarySelectionSaved:Boolean(effective?.selection),
    librarySelectable:type==='jellyfin',
    libraryError:error?String(error.message||error):null
  };
}

async function accessAccountsForCustomer(customerId,portal){
  const portalAccounts=new Map((Array.isArray(portal?.accounts)?portal.accounts:[]).map(account=>[String(account.id),account]));
  const rows=await mediaRows(customerId),result=[];
  for(const account of rows){
    const entitlement=await entitlementForAccount(customerId,account);
    if(mediaType(account)!=='jellyfin'){
      result.push(mergeAccount(account,portalAccounts.get(String(account.id)),null,entitlement));
      continue;
    }
    try{
      const profile=entitlement?await provisioning.libraryPolicyForAccount(customerId,account,entitlement):null;
      result.push(mergeAccount(account,portalAccounts.get(String(account.id)),profile,entitlement));
    }catch(error){
      console.warn('Customer My Access library profile unavailable:',{customerId,accountId:account.id,error:error.message});
      result.push(mergeAccount(account,portalAccounts.get(String(account.id)),null,entitlement,error));
    }
  }
  return result;
}

async function requestStateForCustomer(customerId){
  const [access,configuration]=await Promise.all([
    requestUsers.requestAccessForCustomer(customerId).catch(()=>null),
    requestUsers.configuration().catch(()=>({configured:false}))
  ]);
  return{
    access,
    configuration,
    eligible:Boolean(configuration?.configured&&access?.entitlement_active)
  };
}

async function assertMediaAccess(customerId,accountId){
  const rows=await mediaRows(customerId);
  const account=rows.find(row=>String(row.id)===String(accountId));
  if(!account)throw new Error('Streaming account not found.');
  if(account.disabled||!account.server_enabled)throw new Error(`${mediaLabel(account)} access is currently unavailable.`);
  const entitlement=await entitlementForAccount(customerId,account);
  if(!entitlement||entitlement.blocked)throw new Error(`${mediaLabel(account)} credential management requires current ${mediaLabel(account)} access.`);
  return{account,entitlement};
}

function createCustomerJellyfinRouter(){
  const router=express.Router();

  router.get('/account/jellyfin',requireCustomer,legacyAccessRedirect);
  router.get('/account/access',requireCustomer,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const customerId=req.session.customerId;
      const portal=await customers.getCustomerPortal(customerId);
      const subscriptions=(Array.isArray(portal?.subscriptions)?portal.subscriptions:[])
        .filter(customerNav.liveSubscription)
        .sort((a,b)=>new Date(a.created_at||0)-new Date(b.created_at||0));
      const [accounts,requestState]=await Promise.all([
        accessAccountsForCustomer(customerId,portal),
        requestStateForCustomer(customerId)
      ]);
      if(!subscriptions.length&&!accounts.length&&!requestState.eligible){
        return res.redirect('/account?error='+encodeURIComponent('You do not currently have active streaming access.'));
      }
      res.setHeader('Cache-Control','no-store, private, max-age=0');
      res.setHeader('Pragma','no-cache');
      return res.render('customer/jellyfin',{
        siteName:runtimeSettings.siteName(),portal,accounts,subscriptions,requestState,
        navOptions:customerNav.optionsFromPortal(portal),csrfToken:csrf.token(req),
        message:req.query.message||null,error:req.query.error||null
      });
    }catch(error){return next(error);}
  });

  router.post('/account/access/media/:accountId/password',requireCustomer,mediaMutationLimit,async(req,res)=>{
    if(!csrf.verify(req))return redirectAccess(res,'error','Invalid or expired security token',`account-${req.params.accountId}`);
    const password=String(req.body.password||''),confirm=String(req.body.confirmPassword||'');
    if(password.length<12||password.length>200)return redirectAccess(res,'error','Streaming-service passwords must be between 12 and 200 characters.',`account-${req.params.accountId}`);
    if(password!==confirm)return redirectAccess(res,'error','Passwords do not match.',`account-${req.params.accountId}`);
    try{
      const {account}=await assertMediaAccess(req.session.customerId,req.params.accountId);
      await provisioning.setJellyfinPassword(req.session.customerId,req.params.accountId,password);
      await query(`UPDATE jellyfin_accounts SET password_setup_required=FALSE,password_reset_required=FALSE,updated_at=NOW() WHERE id=$1 AND customer_id=$2`,[req.params.accountId,req.session.customerId]);
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.media_password.change','customer',$2,$3::jsonb)`,[
        req.session.customerUserId,req.session.customerId,JSON.stringify({accountId:req.params.accountId,serviceType:mediaType(account),source:'my_access',secretStored:false})
      ]).catch(()=>{});
      return redirectAccess(res,'message',`${mediaLabel(account)} password updated.`,`account-${req.params.accountId}`);
    }catch(error){return redirectAccess(res,'error',error.message||'Streaming-service password could not be updated.',`account-${req.params.accountId}`);}
  });

  router.post('/account/access/media/:accountId/username',requireCustomer,mediaMutationLimit,async(req,res)=>{
    if(!csrf.verify(req))return redirectAccess(res,'error','Invalid or expired security token',`account-${req.params.accountId}`);
    try{
      const {account}=await assertMediaAccess(req.session.customerId,req.params.accountId);
      await provisioning.renameJellyfinAccount(req.session.customerId,req.params.accountId,req.body.username,{actorUserId:req.session.customerUserId});
      return redirectAccess(res,'message',`${mediaLabel(account)} username updated. Your watched history and profile stay with the same account.`,`account-${req.params.accountId}`);
    }catch(error){return redirectAccess(res,'error',error.message||'Streaming username could not be updated.',`account-${req.params.accountId}`);}
  });

  router.post('/account/access/requests/password',requireCustomer,requestPasswordLimit,async(req,res)=>{
    if(!csrf.verify(req))return redirectAccess(res,'error','Invalid or expired security token','overseerr');
    const password=String(req.body.password||''),confirm=String(req.body.confirmPassword||'');
    if(password.length<12||password.length>200)return redirectAccess(res,'error','Overseerr password must be between 12 and 200 characters.','overseerr');
    if(password!==confirm)return redirectAccess(res,'error','Overseerr passwords do not match.','overseerr');
    try{
      const state=await requestStateForCustomer(req.session.customerId);
      if(!state.eligible)throw new Error('Overseerr password management requires an active plan or trial.');
      await requestUsers.setCustomerPassword(req.session.customerId,password);
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.request_password.change','customer',$2,$3::jsonb)`,[
        req.session.customerUserId,req.session.customerId,JSON.stringify({source:'my_access',secretStored:false})
      ]).catch(()=>{});
      return redirectAccess(res,'message','Overseerr password updated.','overseerr');
    }catch(error){return redirectAccess(res,'error',error.message||'Overseerr password could not be updated.','overseerr');}
  });

  return router;
}

module.exports={createCustomerJellyfinRouter,accessAccountsForCustomer,mediaRows,mergeAccount,entitlementForAccount,requestStateForCustomer,assertMediaAccess};
