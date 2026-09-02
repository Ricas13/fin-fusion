'use strict';

const fs=require('fs');
const path=require('path');
const ejs=require('ejs');
const customers=require('../customers');
const runtimeSettings=require('./runtime-settings');

const templatePath=path.join(__dirname,'../../views/customer/_nav.ejs');
const renderNav=ejs.compile(fs.readFileSync(templatePath,'utf8'),{filename:templatePath});

function liveSubscription(subscription){
  if(subscription?.is_addon||subscription?.superseded_by)return false;
  if(!['active','trialing','past_due','paused'].includes(String(subscription?.status||'')))return false;
  if(!subscription.current_period_end)return true;
  const end=new Date(subscription.current_period_end);
  return !Number.isNaN(end.getTime())&&end.getTime()>Date.now();
}
function liveRequestEntitlement(portal){
  const subscriptions=Array.isArray(portal?.subscriptions)?portal.subscriptions:[];
  return subscriptions.some(liveSubscription);
}
function liveJellyfinEntitlement(portal){
  const subscriptions=Array.isArray(portal?.subscriptions)?portal.subscriptions:[];
  return subscriptions.some(subscription=>{
    if(!liveSubscription(subscription))return false;
    const service=String(subscription.service_type_snapshot||subscription.service_type||'jellyfin').toLowerCase();
    return service==='jellyfin'||service==='bundle';
  });
}

function optionsFromPortal(portal){
  const hasServiceAccess=liveRequestEntitlement(portal);
  const hasJellyfinAccess=liveJellyfinEntitlement(portal);
  return{
    showBenefits:Boolean(portal&&portal.referralsEnabled&&portal.referralCode),
    showServicePasswords:hasServiceAccess,
    showAccess:hasServiceAccess,
    // Compatibility for older partials/tests while My Access replaces the
    // Jellyfin-only navigation destination.
    showJellyfin:hasJellyfinAccess,
    overseerrUrl:hasServiceAccess?String(runtimeSettings.overseerrUrl()||''):''
  };
}

async function optionsForCustomer(customerId){
  await runtimeSettings.ensureLoaded();
  const portal=await customers.getCustomerPortal(customerId);
  return optionsFromPortal(portal);
}

function nav(active='',options={}){
  const surface=String(active||'');
  const signedInAccountSurface=(['account','security'].includes(surface)||surface==='passwords')&&Object.prototype.hasOwnProperty.call(options||{},'showBenefits');
  return renderNav({active,...options,standaloneHeader:signedInAccountSurface,siteName:runtimeSettings.siteName()});
}

module.exports={nav,optionsFromPortal,optionsForCustomer,liveRequestEntitlement,liveJellyfinEntitlement,liveSubscription};
