'use strict';

const fs=require('fs');
const path=require('path');
const ejs=require('ejs');
const customers=require('../customers');
const runtimeSettings=require('./runtime-settings');

const templatePath=path.join(__dirname,'../../views/customer/_nav.ejs');
const renderNav=ejs.compile(fs.readFileSync(templatePath,'utf8'),{filename:templatePath});

function periodIsLive(subscription){
  if(!['active','trialing','past_due','paused'].includes(String(subscription?.status||'')))return false;
  if(!subscription.current_period_end)return true;
  const end=new Date(subscription.current_period_end);
  return !Number.isNaN(end.getTime())&&end.getTime()>Date.now();
}
function liveSubscription(subscription){
  if(subscription?.is_addon||subscription?.superseded_by)return false;
  return periodIsLive(subscription);
}
function liveServiceSubscription(subscription){
  if(subscription?.superseded_by||!periodIsLive(subscription))return false;
  const service=String(subscription?.service_type_snapshot||subscription?.service_type||'jellyfin').toLowerCase();
  return ['jellyfin','emby','stremio','bundle'].includes(service);
}
function liveRequestEntitlement(portal){
  const subscriptions=Array.isArray(portal?.subscriptions)?portal.subscriptions:[];
  return subscriptions.some(liveSubscription);
}
function liveJellyfinEntitlement(portal){
  const subscriptions=Array.isArray(portal?.subscriptions)?portal.subscriptions:[];
  return subscriptions.some(subscription=>{
    if(!liveServiceSubscription(subscription))return false;
    const service=String(subscription.service_type_snapshot||subscription.service_type||'jellyfin').toLowerCase();
    return service==='jellyfin'||service==='bundle';
  });
}

function canonicalAccessFlags(portal){
  const snapshot=portal?.accessSnapshot;
  if(!snapshot)return null;
  const primary=Boolean(snapshot.primary?.entitlement);
  const free=Boolean(snapshot.free?.entitlement);
  const stremio=Boolean(snapshot.stremio?.entitlement);
  const emby=Boolean(snapshot.emby?.entitlement);
  return{
    hasServiceAccess:primary||free||stremio||emby,
    hasJellyfinAccess:primary||free
  };
}

function optionsFromPortal(portal){
  const canonical=canonicalAccessFlags(portal);
  const subscriptions=Array.isArray(portal?.subscriptions)?portal.subscriptions:[];
  const hasServiceAccess=canonical?.hasServiceAccess??subscriptions.some(liveServiceSubscription);
  const hasRequestAccess=canonical?canonical.hasServiceAccess:liveRequestEntitlement(portal);
  const hasJellyfinAccess=canonical?.hasJellyfinAccess??liveJellyfinEntitlement(portal);
  return{
    showBenefits:Boolean(portal&&portal.referralsEnabled),
    showServicePasswords:hasRequestAccess,
    showAccess:hasServiceAccess,
    // Compatibility for older partials/tests while My Access replaces the
    // Jellyfin-only navigation destination.
    showJellyfin:hasJellyfinAccess,
    overseerrUrl:hasRequestAccess?String(runtimeSettings.overseerrUrl()||''):''
  };
}

async function optionsForCustomer(customerId){
  await runtimeSettings.ensureLoaded();
  const portal=await customers.getCurrentCustomerPortal(customerId);
  return optionsFromPortal(portal);
}

function nav(active='',options={}){
  const surface=String(active||'');
  const signedInAccountSurface=(['account','security'].includes(surface)||surface==='passwords')&&Object.prototype.hasOwnProperty.call(options||{},'showBenefits');
  return renderNav({active,...options,standaloneHeader:signedInAccountSurface,siteName:runtimeSettings.siteName()});
}

module.exports={nav,optionsFromPortal,optionsForCustomer,canonicalAccessFlags,liveRequestEntitlement,liveJellyfinEntitlement,liveSubscription,liveServiceSubscription,periodIsLive};
