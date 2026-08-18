'use strict';

const express=require('express');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/activity'))}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
async function activity(customerId){
  const [activityRows,eventRows]=await Promise.all([
    query(`SELECT ph.item_name,ph.item_type,ph.client_name,ph.device_name,ph.playback_method,ph.started_at,ph.last_seen_at,ph.ended_at,ph.ended_reason,js.name server_name FROM playback_history ph LEFT JOIN jellyfin_servers js ON js.id=ph.server_id WHERE ph.customer_id=$1 ORDER BY ph.started_at DESC LIMIT 100`,[customerId]),
    query(`SELECT decision,mode,stream_count,stream_limit,reason,created_at FROM stream_policy_events WHERE customer_id=$1 AND decision IN('would_stop','stopped','stop_failed','skipped_safety') ORDER BY created_at DESC LIMIT 50`,[customerId])
  ]);
  return{activity:activityRows.rows,events:eventRows.rows};
}
function createCustomerActivityRouter(){
  const r=express.Router();r.use('/account/activity',requireCustomer,noStore);
  r.get('/account/activity',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const data=await activity(req.session.customerId);return res.render('customer/activity',{siteName:runtimeSettings.siteName(),...data});}catch(error){next(error)}});
  return r;
}

module.exports={createCustomerActivityRouter,activity};
