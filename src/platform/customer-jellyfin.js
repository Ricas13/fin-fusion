'use strict';

const express=require('express');
const {rateLimit}=require('express-rate-limit');
const customers=require('../customers');
const provisioning=require('../jellyfin/resilient-provisioning');
const subscriptionState=require('../entitlements/subscription-state');
const cleanupReturn=require('../entitlements/jellyfin-cleanup-return');
const inactivityStatus=require('../automation/customer-inactivity-status');
const runtimeSettings=require('./runtime-settings');
const customerNav=require('./customer-nav-html');
const requestUsers=require('../integrations/request-user-sync');
const routeRateLimit=require('../security/route-rate-limit');
const csrf=require('../auth/csrf');
const {query}=require('../db');

const accessSurfaceLimit=rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false,message:'Too many access requests. Try again shortly.'});
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
function serviceType(subscription){const type=String(subscription?.service_type_snapshot||subscription?.service_type||'jellyfin').toLowerCase();return ['jellyfin','emby','stremio','bundle'].includes(type)?type:'jellyfin';}
function subscriptionKind(subscription){if(subscription?.is_free_tier)return'Free Server';const type=serviceType(subscription);if(type==='emby')return'Emby Share';if(type==='stremio')return'Stremio';if(type==='bundle')return'Jellyfin + Stremio';return String(subscription?.billing_interval_snapshot||subscription?.billing_interval)==='trial'?'Jellyfin trial':'Premium Jellyfin';}
function subscriptionName(subscription){return subscription?.plan_name||subscription?.contract_plan_name||subscription?.name||subscription?.plan_code||subscription?.code||'Streaming access';}
function planPriceMinor(subscription){const value=subscription?.price_minor_snapshot??subscription?.price_minor??0;return Number.isFinite(Number(value))?Number(value):0;}
function asDate(value){if(!value)return null;const date=new Date(value);return Number.isNaN(date.getTime())?null:date;}
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
function markRemovedFreeAccess(subscriptions,returnStatus){
  const rows=Array.isArray(subscriptions)?subscriptions:[];
  if(!returnStatus?.canRestoreDeletedFree)return rows;
  const freePlanId=String(returnStatus.freePlanId||'');
  return rows.map(subscription=>{
    if(!subscription?.is_free_tier)return subscription;
    if(freePlanId&&String(subscription.plan_id||'')!==freePlanId)return subscription;
    return{...subscription,access_removed:true,access_removed_reason:'inactivity'};
  });
}
function inactiveReason(subscription,holdType=null,{removedForInactivity=false}={}){
  if(removedForInactivity||holdType==='inactivity_policy'||holdType==='jellyfin_cleanup')return'Free Server access was removed because the activity requirements were not met.';
  if(holdType==='payment_delinquency')return'Access ended because payment could not be collected.';
  if(holdType==='admin_hold'||holdType==='admin_disabled')return'Access was removed by an administrator.';
  const status=String(subscription?.status||'').toLowerCase();
  const interval=String(subscription?.billing_interval_snapshot||subscription?.billing_interval||'').toLowerCase();
  if(status==='refunded'||status==='refund')return'Access ended because the payment was refunded.';
  if(status==='canceled'||status==='cancelled')return'Your subscription was cancelled and this access is no longer active.';
  if(status==='expired'&&interval==='trial')return'Your trial ended.';
  if(status==='expired')return'This plan reached the end of its access period.';
  const end=asDate(subscription?.current_period_end);
  if(end&&end.getTime()<=Date.now())return interval==='trial'?'Your trial ended.':'This plan reached the end of its access period.';
  return'This plan is no longer active.';
}
function inactiveEndAt(subscription){return subscription?.current_period_end||subscription?.canceled_at||subscription?.cancelled_at||subscription?.updated_at||null;}
function hoursUntil(date,now=Date.now()){const parsed=asDate(date);return parsed?(parsed.getTime()-now)/3600000:null;}
function addHours(date,hours){const parsed=asDate(date);return parsed&&Number.isFinite(hours)?new Date(parsed.getTime()+hours*3600000):null;}
function freeAccessHealth(status,{now=Date.now()}={}){
  if(!status?.applies)return null;
  const policy=status.policy||{},minimumObservationHours=Math.max(0,Number(policy.minimumObservationHours)||0),deadlines=[];
  const noPlaybackDays=Number(policy.noPlaybackDays),playbackWindowDays=Number(policy.playbackWindowDays),minimumPlaybackMinutes=Number(policy.minimumPlaybackMinutes);
  const observation=asDate(status.observationStartedAt),inactiveReference=asDate(status.inactiveReferenceAt);
  if(Number.isFinite(noPlaybackDays)&&noPlaybackDays>0){
    const inactivityDeadline=addHours(inactiveReference,noPlaybackDays*24),observationDeadline=addHours(observation,Math.max(minimumObservationHours,noPlaybackDays*24));
    if(inactivityDeadline)deadlines.push(inactivityDeadline);if(observationDeadline)deadlines.push(observationDeadline);
  }
  if(Number.isFinite(minimumPlaybackMinutes)&&minimumPlaybackMinutes>0&&Number.isFinite(playbackWindowDays)&&playbackWindowDays>0){
    const usageDeadline=addHours(observation,Math.max(minimumObservationHours,playbackWindowDays*24));if(usageDeadline)deadlines.push(usageDeadline);
  }
  const removalAt=deadlines.length?new Date(Math.max(...deadlines.map(date=>date.getTime()))):null;
  const remainingHours=removalAt?hoursUntil(removalAt,now):null;
  const rules=[];
  if(Number.isFinite(noPlaybackDays)&&noPlaybackDays>0)rules.push(`do not go ${noPlaybackDays} day${noPlaybackDays===1?'':'s'} without playback`);
  if(Number.isFinite(minimumPlaybackMinutes)&&minimumPlaybackMinutes>0&&Number.isFinite(playbackWindowDays)&&playbackWindowDays>0)rules.push(`watch at least ${minimumPlaybackMinutes} minutes in each ${playbackWindowDays}-day window`);
  const rulesText=rules.length?`To keep Free Server access, ${rules.join(' and ')}.`:'Keep using the Free Server regularly to retain your place.';
  if(status.automationProtected)return{tone:'good',label:'Protected',detail:'This account is protected from automatic inactivity removal.',rulesText,removalAt:null,remainingHours:null,playbackMinutes:status.playbackMinutes,minimumPlaybackMinutes,playbackWindowDays};
  if(status.currentlyPlaying)return{tone:'good',label:"You're good",detail:'You are currently playing something on the Free Server.',rulesText,removalAt,remainingHours,playbackMinutes:status.playbackMinutes,minimumPlaybackMinutes,playbackWindowDays};
  if(!status.enforcementReady)return{tone:'good',label:"You're good",detail:'Automatic inactivity removal is currently paused while activity telemetry is unavailable.',rulesText,removalAt:null,remainingHours:null,playbackMinutes:status.playbackMinutes,minimumPlaybackMinutes,playbackWindowDays};
  if(Number.isFinite(minimumPlaybackMinutes)&&minimumPlaybackMinutes>0&&status.playbackMinutes>=minimumPlaybackMinutes)return{tone:'good',label:"You're good",detail:`You have ${status.playbackMinutes} minutes of playback in the current ${playbackWindowDays}-day window.`,rulesText,removalAt,remainingHours,playbackMinutes:status.playbackMinutes,minimumPlaybackMinutes,playbackWindowDays};
  if(status.eligible||remainingHours!=null&&remainingHours<=12)return{tone:'bad',label:'Removal risk',detail:status.eligible?'The activity threshold has been reached. Access can be removed on the next automation run.':`Less than ${Math.max(1,Math.ceil(remainingHours))} hours remain before the inactivity threshold is reached.`,rulesText,removalAt,remainingHours,playbackMinutes:status.playbackMinutes,minimumPlaybackMinutes,playbackWindowDays};
  if(remainingHours!=null&&remainingHours<=48)return{tone:'warn',label:'48-hour warning',detail:`About ${Math.max(1,Math.ceil(remainingHours))} hours remain before the inactivity threshold is reached.`,rulesText,removalAt,remainingHours,playbackMinutes:status.playbackMinutes,minimumPlaybackMinutes,playbackWindowDays};
  return{tone:'good',label:"You're good",detail:remainingHours==null?'Your Free Server activity is currently within the allowed limits.':`About ${Math.max(1,Math.ceil(remainingHours))} hours remain before inactivity could qualify for removal.`,rulesText,removalAt,remainingHours,playbackMinutes:status.playbackMinutes,minimumPlaybackMinutes,playbackWindowDays};
}
async function inactiveAccessHistory(customerId,portal,returnStatus){
  const holdResult=await query(`SELECT hold_type,source_key,reason,created_at FROM customer_access_holds WHERE customer_id=$1 AND released_at IS NULL ORDER BY created_at DESC`,[customerId]).catch(()=>({rows:[]}));
  const holdByPlan=new Map();
  for(const hold of holdResult.rows||[]){const match=String(hold.source_key||'').match(/^plan:(.+)$/);if(match&&!holdByPlan.has(match[1]))holdByPlan.set(match[1],hold);}
  const freePlanId=String(returnStatus?.freePlanId||'');
  const rows=(Array.isArray(portal?.subscriptions)?portal.subscriptions:[]).filter(subscription=>!subscription?.is_addon&&['jellyfin','emby','stremio','bundle'].includes(serviceType(subscription)));
  const items=[];
  for(const subscription of rows){
    const planId=String(subscription.plan_id||''),hold=holdByPlan.get(planId)||null,removedForInactivity=Boolean(returnStatus?.canRestoreDeletedFree&&subscription.is_free_tier&&(!freePlanId||planId===freePlanId));
    if(customerNav.liveServiceSubscription(subscription)&&!hold&&!removedForInactivity)continue;
    items.push({
      id:String(subscription.id||subscription.subscription_id||`${planId}:${subscription.created_at||''}`),
      planId:planId||null,
      planCode:subscription.plan_code||subscription.contract_plan_code||subscription.code||null,
      planName:subscriptionName(subscription),
      kind:subscriptionKind(subscription),
      reason:inactiveReason(subscription,hold?.hold_type,{removedForInactivity}),
      endedAt:inactiveEndAt(subscription),
      paid:planPriceMinor(subscription)>0&&String(subscription.billing_interval_snapshot||subscription.billing_interval||'')!=='trial',
      status:String(subscription.status||'inactive')
    });
  }
  const deduped=new Map();
  for(const item of items.sort((a,b)=>new Date(b.endedAt||0)-new Date(a.endedAt||0))){const key=item.planId||item.planCode||item.id;if(!deduped.has(key))deduped.set(key,item);}
  return[...deduped.values()].slice(0,8);
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
    disabled:Boolean(!entitlement||account.disabled||!account.server_enabled||entitlement?.blocked),
    passwordSetupRequired:Boolean(account.password_setup_required),
    canRename:Boolean(portalAccount?.can_rename_jellyfin_username),
    planName:entitlementName(entitlement),
    streams:entitlementStreams(entitlement),
    subscriptionId:entitlement?.subscription_id||null,
    availableLibraries:available,
    selectedLibraries:selected,
    librarySelectionSaved:Boolean(effective?.selection),
    librarySelectable:type==='jellyfin'&&Boolean(entitlement),
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
  router.use('/account/access',accessSurfaceLimit);

  router.get('/account/jellyfin',requireCustomer,legacyAccessRedirect);
  router.get('/account/access-history.json',requireCustomer,async(req,res)=>{
    try{
      const customerId=req.session.customerId,portal=await customers.getCustomerPortal(customerId),returnStatus=await cleanupReturn.returningCustomerStatus(customerId).catch(()=>({eligible:false,canRestoreDeletedFree:false,freePlanId:null}));
      res.setHeader('Cache-Control','no-store, private, max-age=0');
      return res.json({items:await inactiveAccessHistory(customerId,portal,returnStatus)});
    }catch(error){console.warn('Customer inactive access history unavailable:',{customerId:req.session.customerId,error:error.message});return res.status(503).json({items:[]});}
  });
  router.get('/account/access',requireCustomer,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const customerId=req.session.customerId;
      const portal=await customers.getCustomerPortal(customerId);
      const rawSubscriptions=(Array.isArray(portal?.subscriptions)?portal.subscriptions:[])
        .filter(customerNav.liveServiceSubscription)
        .sort((a,b)=>new Date(a.created_at||0)-new Date(b.created_at||0));
      const [accounts,requestState,returnStatus,rawFreeUsage]=await Promise.all([
        accessAccountsForCustomer(customerId,portal),
        requestStateForCustomer(customerId),
        cleanupReturn.returningCustomerStatus(customerId).catch(error=>({eligible:false,canRestoreDeletedFree:false,freePlanId:null,error:error.message})),
        inactivityStatus.customerStatus(customerId).catch(error=>({applies:false,error:error.message,telemetry:{ready:false}}))
      ]);
      const subscriptions=markRemovedFreeAccess(rawSubscriptions,returnStatus),freeUsage=freeAccessHealth(rawFreeUsage);
      if(!subscriptions.length&&!requestState.eligible){
        return res.redirect('/account?error='+encodeURIComponent('You do not currently have active streaming access.'));
      }
      res.setHeader('Cache-Control','no-store, private, max-age=0');
      res.setHeader('Pragma','no-cache');
      return res.render('customer/jellyfin',{
        siteName:runtimeSettings.siteName(),portal,accounts,subscriptions,requestState,returnStatus,freeUsage,
        navOptions:customerNav.optionsFromPortal(portal),csrfToken:csrf.token(req),
        message:req.query.message||null,error:req.query.error||returnStatus.error||rawFreeUsage.error||null
      });
    }catch(error){return next(error);}
  });

  router.post('/account/access/media/:accountId/password',requireCustomer,mediaMutationLimit,async(req,res)=>{
    if(!csrf.verify(req))return redirectAccess(res,'error','Invalid or expired security token',`account-${req.params.accountId}`);
    const password=String(req.body.password||''),confirm=String(req.body.confirmPassword||'');
    if(password.length<8||password.length>200)return redirectAccess(res,'error','Streaming-service passwords must be between 8 and 200 characters.',`account-${req.params.accountId}`);
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
    if(password.length<8||password.length>200)return redirectAccess(res,'error','Overseerr password must be between 8 and 200 characters.','overseerr');
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

module.exports={createCustomerJellyfinRouter,accessAccountsForCustomer,mediaRows,mergeAccount,entitlementForAccount,requestStateForCustomer,assertMediaAccess,markRemovedFreeAccess,freeAccessHealth,inactiveAccessHistory};
