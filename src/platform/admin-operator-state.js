'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const reporting=require('./reporting-currency');
const routeRateLimit=require('../security/route-rate-limit');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.status(401).json({ok:false,error:'unauthorized'});}
function epoch(value){return value?new Date(value).getTime():0;}
const unreadLimit=routeRateLimit.middleware({scope:'admin-operator-unread',max:120,windowSeconds:60});
const reportingCurrencyLimit=routeRateLimit.middleware({scope:'admin-reporting-currency',max:20,windowSeconds:60});

async function snapshot(){
  const [customers,resellers,attention,servers,payments]=await Promise.all([
    query(`SELECT COUNT(*)::int n,MAX(created_at) updated FROM customers WHERE created_at>NOW()-INTERVAL '7 days'`),
    query(`SELECT COUNT(*)::int n,MAX(created_at) updated FROM resellers WHERE created_at>NOW()-INTERVAL '7 days'`),
    query(`SELECT COUNT(*)::int n,MAX(updated_at) updated FROM attention_state WHERE status IN ('open','acknowledged')`),
    query(`SELECT COUNT(*)::int n,MAX(last_health_check) updated FROM jellyfin_servers WHERE enabled=TRUE AND health_status IN ('degraded','offline')`),
    query(`SELECT COUNT(*)::int n,MAX(created_at) updated FROM payment_events WHERE created_at>NOW()-INTERVAL '7 days' AND (processing_error IS NOT NULL OR processed_at IS NULL)`)
  ]);
  const rows={customers:customers.rows[0],resellers:resellers.rows[0],attention:attention.rows[0],servers:servers.rows[0],payments:payments.rows[0]};
  return {
    counts:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,Number(v?.n||0)])),
    updatedAt:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,epoch(v?.updated)]))
  };
}

function createAdminOperatorStateRouter(){
  const router=express.Router();
  // Mount abuse protection before authorization, matching the security shape
  // used by the other admin control surfaces. The route handlers below never
  // execute until both the shared persistent limiter and the admin gate pass.
  router.use('/admin/api/operator-state/unread',unreadLimit,gate);
  router.get('/admin/api/operator-state/unread',async(_req,res)=>{
    try{res.setHeader('Cache-Control','no-store, private');res.json({ok:true,...await snapshot()});}
    catch(error){console.error('operator unread snapshot failed:',error.message);res.status(500).json({ok:false,error:'snapshot_failed'});}
  });
  router.use('/admin/reporting-currency',reportingCurrencyLimit,gate);
  router.post('/admin/reporting-currency',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{const saved=await reporting.saveCurrency(req.body.currency,req.session.authUserId);return res.redirect('/admin?message='+encodeURIComponent(`Dashboard reporting currency changed to ${saved.currency}.`));}
    catch(error){return res.redirect('/admin?error='+encodeURIComponent(error.message||'Reporting currency could not be changed.'));}
  });
  return router;
}

module.exports={createAdminOperatorStateRouter,snapshot};
