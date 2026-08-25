'use strict';
const express=require('express');
const {pool}=require('../db');
const runtimeSettings=require('./runtime-settings');
const customers=require('../customers');
const activity=require('../activity/playback');
const customerSecurity=require('./customer-security');
const customerNav=require('./customer-nav-html');
const router=express.Router();
router.use(customerSecurity.requireCustomer);
async function data(customerId){
 const [history,live,portal]=await Promise.all([
  pool.query(`SELECT ph.id,ph.item_name,ph.item_type,ph.client_name,ph.device_name,ph.playback_method,ph.transcode_reasons,ph.started_at,ph.last_seen_at,ph.ended_at,ph.ended_reason,s.name AS server_name FROM playback_history ph LEFT JOIN servers s ON s.id=ph.server_id WHERE ph.customer_id=$1 ORDER BY ph.started_at DESC LIMIT 100`,[customerId]),
  activity.listLiveSessions(customerId),
  customers.getCustomerPortal(customerId)
 ]);
 return{history:history.rows,live,me:portal.customer,navOptions:customerNav.optionsFromPortal(portal)};
}
router.get('/account/activity',async(req,res)=>{
 try{
  await runtimeSettings.ensureLoaded();
  const d=await data(req.session.customerId);
  return res.render('customer/activity',{siteName:runtimeSettings.siteName(),csrfToken:req.csrfToken(),customer:d.me,history:d.history,live:d.live,navOptions:d.navOptions,message:req.query.message||'',error:req.query.error||''});
 }catch(err){
  req.log?.error?.(err);
  return res.status(500).send('Request failed.');
 }
});
module.exports=router;
