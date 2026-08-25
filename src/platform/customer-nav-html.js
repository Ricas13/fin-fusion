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
  return renderNav({active,...options});
}

module.exports={nav,optionsFromPortal,optionsForCustomer};
