'use strict';

const fs=require('fs');
const path=require('path');
const ejs=require('ejs');
const customers=require('../customers');
const runtimeSettings=require('./runtime-settings');

const templatePath=path.join(__dirname,'../../views/customer/_nav.ejs');
const renderNav=ejs.compile(fs.readFileSync(templatePath,'utf8'),{filename:templatePath});

function optionsFromPortal(portal){
  return{
    showBenefits:Boolean(portal&&portal.referralsEnabled&&portal.referralCode),
    overseerrUrl:String(runtimeSettings.overseerrUrl()||'')
  };
}

async function optionsForCustomer(customerId){
  await runtimeSettings.ensureLoaded();
  const portal=await customers.getCustomerPortal(customerId);
  return optionsFromPortal(portal);
}

function nav(active='',options={}){
  const signedInAccountSurface=['account','security'].includes(String(active||''))&&Object.prototype.hasOwnProperty.call(options||{},'showBenefits');
  return renderNav({active,...options,standaloneHeader:signedInAccountSurface,siteName:runtimeSettings.siteName()});
}

module.exports={nav,optionsFromPortal,optionsForCustomer};
