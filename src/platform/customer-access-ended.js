'use strict';

const express=require('express');
const customers=require('../customers');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const customerNav=require('./customer-nav-html');

function requireCustomer(req,res,next){
  return req.session?.customerId&&req.session?.customerUserId
    ? next()
    : res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/access'));
}
function serviceType(subscription){
  const type=String(subscription?.service_type_snapshot||subscription?.service_type||'jellyfin').toLowerCase();
  return ['jellyfin','emby','stremio','bundle'].includes(type)?type:'jellyfin';
}
function subscriptionName(subscription){return subscription?.plan_name||subscription?.contract_plan_name||subscription?.name||subscription?.plan_code||subscription?.code||'Streaming access';}
function subscriptionKind(subscription){
  if(subscription?.is_free_tier)return'Free Server';
  const type=serviceType(subscription);
  if(type==='emby')return'Emby Share';
  if(type==='stremio')return'Stremio';
  if(type==='bundle')return'Jellyfin + Stremio';
  return String(subscription?.billing_interval_snapshot||subscription?.billing_interval||'').toLowerCase()==='trial'?'Jellyfin trial':'Premium Jellyfin';
}
function asDate(value){if(!value)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date:null;}
function firstFiniteInt(value){const n=Number.parseInt(value,10);return Number.isInteger(n)?n:null;}
function triggerList(hold){
  const direct=Array.isArray(hold?.metadata?.triggers)?hold.metadata.triggers.filter(Boolean).map(String):[];
  if(direct.length)return direct;
  const raw=String(hold?.reason||'');
  const prefix='Free-plan Jellyfin usage rule:';
  return raw.startsWith(prefix)?raw.slice(prefix.length).split(';').map(value=>value.trim()).filter(Boolean):[];
}
function inactivityReason(hold){
  const triggers=triggerList(hold);
  const first=triggers.find(value=>/no first Free Server playback within/i.test(value));
  if(first){
    const days=firstFiniteInt(first.match(/within\s+(\d+)\s+day/i)?.[1])||3;
    return `Free Server access was removed because you did not play anything within ${days} day${days===1?'':'s'} of receiving or restoring your place.`;
  }
  const noPlayback=triggers.find(value=>/no Free Server playback for/i.test(value));
  const lowMinutes=triggers.find(value=>/min played on Free Server/i.test(value)&&/below/i.test(value));
  if(noPlayback&&lowMinutes){
    const inactiveDays=firstFiniteInt(noPlayback.match(/for\s+(\d+)\s+day/i)?.[1]);
    const match=lowMinutes.match(/(\d+)\s+min played on Free Server in\s+(\d+)\s+day\(s\), below\s+(\d+)\s+min/i)||lowMinutes.match(/(\d+)\s+min played on Free Server in\s+(\d+)\s+day.*below\s+(\d+)\s+min/i);
    const watched=firstFiniteInt(match?.[1]);
    const windowDays=firstFiniteInt(match?.[2]);
    const minimum=firstFiniteInt(match?.[3]);
    if(inactiveDays&&watched!=null&&windowDays&&minimum!=null){
      return `Free Server access was removed because both ongoing rules were missed: there was no playback for ${inactiveDays} days and only ${watched} minute${watched===1?'':'s'} were watched in the ${windowDays}-day window (minimum ${minimum} minutes).`;
    }
    return'Free Server access was removed because both ongoing activity requirements were not met.';
  }
  if(noPlayback){
    const days=firstFiniteInt(noPlayback.match(/for\s+(\d+)\s+day/i)?.[1])||7;
    return `Free Server access was removed because there was no playback for ${days} days.`;
  }
  if(lowMinutes){
    const match=lowMinutes.match(/(\d+)\s+min played on Free Server in\s+(\d+)\s+day.*below\s+(\d+)\s+min/i);
    if(match)return `Free Server access was removed because only ${match[1]} minutes were watched in the ${match[2]}-day window, below the ${match[3]}-minute minimum.`;
  }
  return'Free Server access was removed because the activity requirements were not met.';
}
function inactiveReason(subscription,hold=null){
  const holdType=String(hold?.hold_type||'');
  if(holdType==='inactivity_policy'||holdType==='jellyfin_cleanup')return inactivityReason(hold);
  if(holdType==='payment_delinquency')return'Access ended because payment could not be collected.';
  if(holdType==='admin_hold'||holdType==='admin_disabled')return'Access was removed by an administrator.';
  const status=String(subscription?.status||'').toLowerCase();
  const interval=String(subscription?.billing_interval_snapshot||subscription?.billing_interval||'').toLowerCase();
  const billingMode=String(subscription?.billing_mode||'').toLowerCase();
  if(status==='refunded'||status==='refund')return'Access ended because the payment was refunded.';
  if(status==='canceled'||status==='cancelled')return'Your subscription was cancelled and this access is no longer active.';
  if(status==='expired'&&interval==='trial')return'Your trial ended.';
  if(status==='expired'&&billingMode==='subscription')return'Your paid access ended because the subscription was not successfully renewed.';
  if(status==='expired')return Number(subscription?.price_minor_snapshot??subscription?.price_minor??0)>0
    ? 'Your paid access period ended and no further paid period is active.'
    : 'This access period ended.';
  if(status==='past_due')return'Access ended because payment was overdue and could not be collected before the paid period ended.';
  const end=asDate(subscription?.current_period_end);
  if(end&&end.getTime()<=Date.now()){
    if(interval==='trial')return'Your trial ended.';
    if(billingMode==='subscription')return'Your paid access ended because the subscription was not successfully renewed.';
    return Number(subscription?.price_minor_snapshot??subscription?.price_minor??0)>0
      ? 'Your paid access period ended and no further paid period is active.'
      : 'This access period ended.';
  }
  return'This plan is no longer active.';
}
function endedAt(subscription,hold){return hold?.created_at||subscription?.current_period_end||subscription?.canceled_at||subscription?.cancelled_at||subscription?.updated_at||null;}
function holdForSubscription(subscription,holds){
  const planId=String(subscription?.plan_id||'');
  const exact=holds.find(hold=>String(hold.source_key||'')===`plan:${planId}`);
  if(exact)return exact;
  const paid=Number(subscription?.price_minor_snapshot??subscription?.price_minor??0)>0;
  if(paid)return holds.find(hold=>hold.hold_type==='payment_delinquency')||null;
  return null;
}
async function accessEndHistory(customerId,portal=null){
  portal=portal||await customers.getCustomerPortal(customerId);
  const holdResult=await query(`SELECT hold_type,source_key,reason,metadata,created_at FROM customer_access_holds WHERE customer_id=$1 AND released_at IS NULL ORDER BY created_at DESC`,[customerId]).catch(()=>({rows:[]}));
  const holds=holdResult.rows||[];
  const rows=(Array.isArray(portal?.subscriptions)?portal.subscriptions:[])
    .filter(subscription=>!subscription?.is_addon&&['jellyfin','emby','stremio','bundle'].includes(serviceType(subscription)));
  const items=[];
  for(const subscription of rows){
    const hold=holdForSubscription(subscription,holds);
    if(customerNav.liveServiceSubscription(subscription)&&!hold)continue;
    items.push({
      id:String(subscription.id||subscription.subscription_id||`${subscription.plan_id||''}:${subscription.created_at||''}`),
      planId:subscription.plan_id||null,
      planName:subscriptionName(subscription),
      kind:subscriptionKind(subscription),
      reason:inactiveReason(subscription,hold),
      reasonCode:hold?.hold_type||String(subscription.status||'inactive').toLowerCase(),
      endedAt:endedAt(subscription,hold),
      status:String(subscription.status||'inactive').toLowerCase(),
      canRestoreFree:Boolean(hold&&hold.hold_type==='inactivity_policy'&&subscription.is_free_tier)
    });
  }
  const deduped=new Map();
  for(const item of items.sort((a,b)=>new Date(b.endedAt||0)-new Date(a.endedAt||0))){const key=String(item.planId||item.id);if(!deduped.has(key))deduped.set(key,item);}
  return[...deduped.values()].slice(0,8);
}
function liveMediaSubscriptions(portal){
  return (Array.isArray(portal?.subscriptions)?portal.subscriptions:[])
    .filter(subscription=>!subscription?.is_addon&&['jellyfin','emby','stremio','bundle'].includes(serviceType(subscription)))
    .filter(customerNav.liveServiceSubscription);
}
function createCustomerAccessEndedRouter(){
  const router=express.Router();
  router.get('/account/access-ended-history.json',requireCustomer,async(req,res)=>{
    try{
      const portal=await customers.getCustomerPortal(req.session.customerId);
      res.setHeader('Cache-Control','no-store, private, max-age=0');
      return res.json({items:await accessEndHistory(req.session.customerId,portal)});
    }catch(error){
      console.warn('Customer access-ended history unavailable:',{customerId:req.session.customerId,error:error.message});
      return res.status(503).json({items:[]});
    }
  });
  router.use('/account/access',requireCustomer,async(req,res,next)=>{
    if(req.method!=='GET')return next();
    try{
      const portal=await customers.getCustomerPortal(req.session.customerId);
      if(liveMediaSubscriptions(portal).length)return next();
      const history=await accessEndHistory(req.session.customerId,portal);
      if(!history.length)return next();
      await runtimeSettings.ensureLoaded();
      res.setHeader('Cache-Control','no-store, private, max-age=0');
      res.setHeader('Pragma','no-cache');
      return res.render('customer/access-ended',{
        siteName:runtimeSettings.siteName(),
        portal,
        history,
        navOptions:customerNav.optionsFromPortal(portal)
      });
    }catch(error){return next(error);}
  });
  return router;
}

module.exports={createCustomerAccessEndedRouter,accessEndHistory,inactiveReason,inactivityReason,triggerList,liveMediaSubscriptions};
