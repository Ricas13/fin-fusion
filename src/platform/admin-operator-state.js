'use strict';

const express=require('express');
const {rateLimit,ipKeyGenerator}=require('express-rate-limit');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const reporting=require('./reporting-currency');
const attention=require('./attention');
const readCursors=require('./operator-read-cursors');
const tickets=require('../support/tickets');
const routeRateLimit=require('../security/route-rate-limit');
const fleetDashboard=require('./admin-server-fleet-dashboard');
const profitability=require('./business-profitability');

function gate(req,res,next){
  if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId){
    res.locals.operatorActorUserId=req.session.authUserId;
    return next();
  }
  return res.status(401).json({ok:false,error:'unauthorized'});
}
function epoch(value){return value?new Date(value).getTime():0;}
function operatorKey(req){return req.session?.authUserId?`admin:${req.session.authUserId}`:`ip:${ipKeyGenerator(req.ip)}`;}
function metricNumber(server,key,fallback=0){return server?.fleet_metrics?.[key]==null?Number(fallback||0):Number(server.fleet_metrics[key]||0);}

const unreadBurstLimit=rateLimit({windowMs:60_000,limit:240,keyGenerator:operatorKey,standardHeaders:false,legacyHeaders:false});
const readBurstLimit=rateLimit({windowMs:60_000,limit:60,keyGenerator:operatorKey,standardHeaders:false,legacyHeaders:false});
const reportingCurrencyBurstLimit=rateLimit({windowMs:60_000,limit:20,keyGenerator:operatorKey,standardHeaders:false,legacyHeaders:false});
const unreadPersistentLimit=routeRateLimit.middleware({scope:'admin-operator-unread',max:240,windowSeconds:60});
const readPersistentLimit=routeRateLimit.middleware({scope:'admin-operator-read',max:60,windowSeconds:60});
const reportingCurrencyPersistentLimit=routeRateLimit.middleware({scope:'admin-reporting-currency',max:20,windowSeconds:60});

async function headerMetrics(){
  const [fleet,reportingState]=await Promise.all([fleetDashboard.dashboardRows(),reporting.get()]);
  const enabled=fleet.filter(row=>row.enabled!==false);
  const activeStreams=enabled.reduce((sum,row)=>sum+metricNumber(row,'active_streams',row.active_streams),0);
  const totalStreams=enabled.reduce((sum,row)=>sum+Number(row.max_users||0),0);
  const currency=reporting.cleanCurrency(reportingState.currency),profit=await profitability.headerProfitability({...reportingState,currency});
  return {
    streams:{active:activeStreams,total:totalStreams},
    monthlyProfit:{minor:profit.current.profitMinor,currency},
    yearlyProfit:{minor:profit.ytd.profitMinor,currency}
  };
}

async function snapshot(adminUserId=null){
  const seen=adminUserId?await readCursors.list(adminUserId):{};
  const [customers,orders,attentionSummary,servers,payments,ticketSummary,metrics]=await Promise.all([
    query(`SELECT COUNT(*)::int n,MAX(created_at) updated FROM customers WHERE created_at>NOW()-INTERVAL '7 days' AND ($1::timestamptz IS NULL OR created_at>$1::timestamptz)`,[seen.customers||null]),
    query(`SELECT COUNT(*)::int n,MAX(created_at) updated FROM subscriptions WHERE created_at>NOW()-INTERVAL '7 days' AND source IN ('stripe','paypal') AND status IN ('active','trialing','past_due','paused') AND ($1::timestamptz IS NULL OR created_at>$1::timestamptz)`,[seen.orders||null]),
    attention.openSummary(),
    query(`SELECT COUNT(*)::int n,MAX(last_health_check) updated FROM jellyfin_servers WHERE enabled=TRUE AND health_status IN ('degraded','offline')`),
    query(`SELECT COUNT(*)::int n,MAX(created_at) updated FROM payment_events WHERE created_at>NOW()-INTERVAL '7 days' AND (processing_error IS NOT NULL OR processed_at IS NULL)`),
    tickets.staffQueueSummary(seen.tickets||null),
    headerMetrics()
  ]);
  const rows={
    customers:customers.rows[0],
    orders:orders.rows[0],
    tickets:{n:ticketSummary.count,updated:ticketSummary.updatedAt},
    attention:{n:attentionSummary.count,updated:attentionSummary.updatedAt},
    servers:servers.rows[0],
    payments:payments.rows[0]
  };
  return {
    counts:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,Number(v?.n||0)])),
    updatedAt:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,epoch(v?.updated)])),
    metrics
  };
}

function createAdminOperatorStateRouter(){
  const router=express.Router();
  router.use('/admin/api/operator-state/unread',unreadBurstLimit,unreadPersistentLimit,gate);
  router.get('/admin/api/operator-state/unread',async(req,res)=>{
    try{
      res.setHeader('Cache-Control','no-store, private');
      res.json({ok:true,csrfToken:csrf.token(req),...await snapshot(res.locals.operatorActorUserId)});
    }catch(error){console.error('operator unread snapshot failed:',error.message);res.status(500).json({ok:false,error:'snapshot_failed'});}
  });
  router.use('/admin/api/operator-state/read',readBurstLimit,readPersistentLimit,gate);
  router.post('/admin/api/operator-state/read',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).json({ok:false,error:'invalid_csrf'});
    try{
      const saved=await readCursors.markSeen(res.locals.operatorActorUserId,req.body.area);
      res.setHeader('Cache-Control','no-store, private');
      return res.json({ok:true,area:saved.area,seenAt:epoch(saved.seen_at)});
    }catch(error){
      if(error.message==='Invalid operator read area.')return res.status(400).json({ok:false,error:'invalid_area'});
      console.error('operator read cursor update failed:',error.message);
      return res.status(500).json({ok:false,error:'cursor_update_failed'});
    }
  });
  router.use('/admin/reporting-currency',reportingCurrencyBurstLimit,reportingCurrencyPersistentLimit,gate);
  router.post('/admin/reporting-currency',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{const saved=await reporting.saveCurrency(req.body.currency,res.locals.operatorActorUserId);return res.redirect('/admin?message='+encodeURIComponent(`Dashboard reporting currency changed to ${saved.currency}.`));}
    catch(error){return res.redirect('/admin?error='+encodeURIComponent(error.message||'Reporting currency could not be changed.'));}
  });
  return router;
}

module.exports={createAdminOperatorStateRouter,snapshot,headerMetrics};