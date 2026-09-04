'use strict';

const express=require('express');
const {rateLimit}=require('express-rate-limit');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const provisioning=require('../jellyfin/resilient-provisioning');
const manualAssignment=require('../jellyfin/manual-assignment');
const forceMove=require('../jellyfin/admin-force-move');
const adminControl=require('../jellyfin/admin-control');
const userCapacity=require('../jellyfin/user-capacity');
const permanentAccess=require('../entitlements/permanent-access');
const {historyKind}=require('../payments/history-accounting');

const surfaceLimit=rateLimit({windowMs:60000,limit:300,standardHeaders:'draft-8',legacyHeaders:false,message:'Too many customer-management requests. Try again shortly.'});
const readLimit=routeRateLimit.middleware({scope:'admin-customer-operator-read',max:120,windowSeconds:60,reason:'admin_customer_operator_read'});
const writeLimit=routeRateLimit.middleware({scope:'admin-customer-operator-write',max:60,windowSeconds:60,reason:'admin_customer_operator_write'});

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function uuid(value){return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value||''));}
function clean(value,max=500){return String(value||'').trim().slice(0,max);}
function customerPath(id,key='',message=''){const notice=key?`&${encodeURIComponent(key)}=${encodeURIComponent(message)}`:'';return `/admin/users/${encodeURIComponent(id)}?tab=access${notice}`;}
function redirect(res,id,key,message){return res.redirect(customerPath(id,key,message));}
function moneySummary(rows){
  const byCurrency=new Map(),payments=[];
  for(const row of rows){
    const kind=historyKind(row);if(!kind)continue;
    const currency=String(row.currency||'').toUpperCase();if(!currency)continue;
    const amount=Math.abs(Number(row.gross_amount_minor||0));
    const current=byCurrency.get(currency)||0;
    byCurrency.set(currency,current+(kind==='payment'?amount:-amount));
    if(kind==='payment')payments.push(row);
  }
  payments.sort((a,b)=>new Date(b.occurred_at||0)-new Date(a.occurred_at||0));
  return{totals:Object.fromEntries(byCurrency),lastPayment:payments[0]?{amountMinor:Math.abs(Number(payments[0].gross_amount_minor||0)),currency:String(payments[0].currency||'').toUpperCase(),at:payments[0].occurred_at}:null};
}

async function metricsFor(ids){
  if(!ids.length)return{};
  const [usage,transactions,permanent,controls]=await Promise.all([
    query(`
      SELECT c.id,
        COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams,
        COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at))) FROM playback_history ph WHERE ph.customer_id=c.id AND ph.started_at>=NOW()-INTERVAL '30 days'),0)::bigint AS watch_seconds_30d,
        (SELECT MAX(ph2.last_seen_at) FROM playback_history ph2 WHERE ph2.customer_id=c.id) AS last_playback_at
      FROM customers c
      LEFT JOIN active_playback_sessions aps ON aps.customer_id=c.id
      WHERE c.id=ANY($1::uuid[])
      GROUP BY c.id
    `,[ids]),
    query(`SELECT customer_id,provider,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor FROM payment_history_transactions WHERE customer_id=ANY($1::uuid[]) ORDER BY occurred_at DESC`,[ids]).catch(()=>({rows:[]})),
    query(`SELECT customer_id,TRUE AS permanent FROM customer_entitlement_overrides WHERE customer_id=ANY($1::uuid[]) AND permanent_access=TRUE AND revoked_at IS NULL`,[ids]),
    query(`SELECT DISTINCT ON(customer_id) customer_id,mode,server_id,reason FROM customer_jellyfin_admin_control WHERE customer_id=ANY($1::uuid[]) ORDER BY customer_id,updated_at DESC`,[ids]).catch(()=>({rows:[]}))
  ]);
  const out=new Map(ids.map(id=>[String(id),{activeStreams:0,watchSeconds30d:0,lastPlaybackAt:null,permanent:false,adminMode:null,payment:{totals:{},lastPayment:null}}]));
  for(const row of usage.rows){const item=out.get(String(row.id));if(!item)continue;item.activeStreams=Number(row.active_streams||0);item.watchSeconds30d=Number(row.watch_seconds_30d||0);item.lastPlaybackAt=row.last_playback_at||null;}
  const transactionGroups=new Map();for(const row of transactions.rows){if(!row.customer_id)continue;const key=String(row.customer_id),list=transactionGroups.get(key)||[];list.push(row);transactionGroups.set(key,list);}
  for(const [id,rows] of transactionGroups){const item=out.get(id);if(item)item.payment=moneySummary(rows);}
  for(const row of permanent.rows){const item=out.get(String(row.customer_id));if(item)item.permanent=true;}
  for(const row of controls.rows){const item=out.get(String(row.customer_id));if(!item)continue;item.adminMode=row.mode;item.adminServerId=row.server_id||null;item.adminReason=row.reason||null;}
  return Object.fromEntries(out);
}

async function context(customerId,req){
  const entitlement=await provisioning.currentEntitlementTruth(customerId);
  // currentEntitlementTruth only sees the jellyfin/bundle lane, so a
  // Stremio-only customer always has entitlement=null here even though they
  // have a live plan. Without this, the client can't tell "no plan at all"
  // apart from "has a Stremio plan" and wrongly shows the Jellyfin-server
  // picker for Stremio customers.
  const stremioEntitlement=entitlement?null:await require('../stremio/entitlements').entitledSubscription(customerId).catch(()=>null);
  const [customer,accounts,permanent,control,rawServers]=await Promise.all([
    query(`SELECT c.id,COALESCE(NULLIF(c.display_name,''),u.username,c.email,'Customer') AS name,c.email,u.username AS portal_username FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[customerId]),
    query(`SELECT ja.id,ja.server_id,ja.jellyfin_username,ja.disabled,ja.is_primary,js.name AS server_name,js.server_class FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=$1 AND ja.account_purpose='jellyfin' ORDER BY ja.is_primary DESC,ja.disabled ASC,ja.updated_at DESC`,[customerId]),
    permanentAccess.status(customerId).catch(()=>null),
    entitlement?adminControl.state(customerId,entitlement.subscription_id).catch(()=>null):Promise.resolve(null),
    query(`
      SELECT js.id,js.name,js.server_class,js.enabled,js.health_status,js.allow_new_users,js.max_users,js.priority
      FROM jellyfin_servers js
      WHERE COALESCE(js.media_server_type,'jellyfin')='jellyfin'
      ORDER BY js.enabled DESC,CASE js.health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END,js.priority,js.name
    `)
  ]);
  if(!customer.rowCount)return null;
  const servers=await userCapacity.decorateServers(rawServers.rows);
  const activeAccounts=accounts.rows.filter(row=>!row.disabled);
  const planName=entitlement?.contract_plan_name||entitlement?.name||entitlement?.plan_name_snapshot||entitlement?.contract_plan_code||null;
  return{
    ok:true,csrfToken:csrf.token(req),customer:customer.rows[0],
    entitlement:entitlement?{subscriptionId:entitlement.subscription_id,planId:entitlement.plan_id,planName,serviceType:String(entitlement.service_type_snapshot||entitlement.service_type||'jellyfin'),serverClass:entitlement.server_class||null,isFreeTier:Boolean(entitlement.is_free_tier),blocked:Boolean(entitlement.blocked)}:null,
    serviceKind:entitlement?String(entitlement.service_type_snapshot||entitlement.service_type||'jellyfin'):stremioEntitlement?'stremio':'none',
    accounts:accounts.rows,activeAccounts,
    permanent:Boolean(permanent?.active),adminControl:control?{mode:control.mode,serverId:control.server_id||null,serverName:control.server_name||null,reason:control.reason||null}:null,
    servers:servers.map(server=>({...server,assigned_users:Number(server.assigned_users||0),full:Boolean(server.full),overBy:Number(server.over_capacity_by||0),operable:Boolean(server.enabled)}))
  };
}

function createAdminCustomerOperatorRouter(){
  const router=express.Router();router.use('/admin/users',surfaceLimit,gate,noStore);

  router.get('/admin/users/operator/metrics',readLimit,async(req,res)=>{
    try{
      const ids=String(req.query.ids||'').split(',').map(v=>v.trim()).filter(uuid).slice(0,100);
      return res.json({ok:true,customers:await metricsFor(ids)});
    }catch(error){console.error('Customer operator metrics failed:',error.message);return res.status(500).json({ok:false,error:'Customer metrics are temporarily unavailable.'});}
  });

  router.get('/admin/users/:customerId/operator/context',readLimit,async(req,res)=>{
    try{if(!uuid(req.params.customerId))return res.status(404).json({ok:false});const result=await context(req.params.customerId,req);if(!result)return res.status(404).json({ok:false,error:'Customer not found'});return res.json(result);}catch(error){console.error('Customer operator context failed:',error.message);return res.status(500).json({ok:false,error:'Customer controls are temporarily unavailable.'});}
  });

  router.post('/admin/users/:customerId/operator/assign',writeLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{const serverId=clean(req.body.serverId,80);if(!uuid(serverId))throw new Error('Choose a Jellyfin server.');const result=await manualAssignment.assign(req.params.customerId,serverId,{actorUserId:req.session.authUserId});return redirect(res,req.params.customerId,'message',`${result.account.jellyfin_username} was added to ${result.server.name}${result.capacityOverride?' even though the configured user capacity is full':''}.`);}catch(error){return redirect(res,req.params.customerId,'error',`Could not add this customer to Jellyfin. ${clean(error.message,300)}`);}
  });

  router.post('/admin/users/:customerId/operator/move',writeLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{const serverId=clean(req.body.serverId,80);if(!uuid(serverId))throw new Error('Choose a destination server.');const result=await forceMove.move(req.params.customerId,serverId,{actorUserId:req.session.authUserId});return redirect(res,req.params.customerId,'message',`Jellyfin access moved to ${result.target.name}. Automatic placement will keep this administrator-selected server.`);}catch(error){return redirect(res,req.params.customerId,'error',`Could not move this customer. ${clean(error.message,300)}`);}
  });

  router.post('/admin/users/:customerId/operator/remove',writeLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{const entitlement=await provisioning.currentEntitlementTruth(req.params.customerId);if(!entitlement)throw new Error('This customer has no Jellyfin entitlement to control.');await adminControl.remove(req.params.customerId,entitlement.subscription_id,{actorUserId:req.session.authUserId,reason:clean(req.body.reason,500)||'Removed from Jellyfin by administrator'});await provisioning.reconcileCustomer(req.params.customerId);return redirect(res,req.params.customerId,'message','Jellyfin access removed by administrator. Background automation will not re-add this entitlement until you return it to automatic management.');}catch(error){return redirect(res,req.params.customerId,'error',`Could not remove Jellyfin access. ${clean(error.message,300)}`);}
  });

  router.post('/admin/users/:customerId/operator/automatic',writeLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{const entitlement=await provisioning.currentEntitlementTruth(req.params.customerId);if(!entitlement)throw new Error('This customer has no current Jellyfin entitlement.');await adminControl.clear(req.params.customerId,entitlement.subscription_id,{actorUserId:req.session.authUserId});let warning='';try{await provisioning.reconcileCustomer(req.params.customerId);}catch(error){warning=` Automatic setup still needs attention: ${clean(error.message,220)}`;}return redirect(res,req.params.customerId,warning?'error':'message',warning?`Returned to automatic management.${warning}`:'Returned to automatic Jellyfin management. Normal plan, user-capacity and lifecycle rules apply again.');}catch(error){return redirect(res,req.params.customerId,'error',`Could not return this customer to automatic management. ${clean(error.message,300)}`);}
  });

  router.post('/admin/users/:customerId/operator/fix',writeLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{await provisioning.reconcileCustomer(req.params.customerId);return redirect(res,req.params.customerId,'message','Jellyfin access checked and updated to match the current customer settings.');}catch(error){return redirect(res,req.params.customerId,'error',`Jellyfin access still needs attention. ${clean(error.message,300)}`);}
  });

  return router;
}

module.exports={createAdminCustomerOperatorRouter,metricsFor,context,moneySummary};