'use strict';
const express=require('express');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const inactivityStatus=require('../automation/customer-inactivity-status');
const customers=require('../customers');
const customerNav=require('./customer-nav-html');
function requireCustomer(req,res,next){return req.session?.customerId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/activity'));}
async function data(customerId){
  const [activityRows,eventRows,freeUsage,portal]=await Promise.all([
    query(`SELECT ph.started_at,ph.ended_at,ph.last_seen_at,ph.item_name,ph.client_name,ph.device_name,ph.playback_method,js.name server_name FROM playback_history ph JOIN jellyfin_servers js ON js.id=ph.server_id WHERE ph.customer_id=$1 ORDER BY COALESCE(ph.last_seen_at,ph.started_at) DESC LIMIT 100`,[customerId]),
    query(`SELECT created_at,decision,reason,stream_limit,observed_streams FROM playback_policy_events WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[customerId]),
    inactivityStatus.customerStatus(customerId).catch(()=>({applies:false,telemetry:{ready:false}})),
    customers.getCustomerPortal(customerId)
  ]);
  return{activity:activityRows.rows,events:eventRows.rows,freeUsage,navOptions:customerNav.optionsFromPortal(portal)};
}
function createCustomerActivityRouter(){const r=express.Router();r.get('/account/activity',requireCustomer,async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const d=await data(req.session.customerId);return res.render('customer/activity',{siteName:runtimeSettings.siteName(),...d});}catch(error){return next(error)}});return r}
module.exports={createCustomerActivityRouter,data};
