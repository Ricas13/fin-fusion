'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { query } = require('../db');
const operations = require('./operations-settings');
const planServers = require('../jellyfin/plan-servers');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function forward(req,anchor='placement'){
  const params=new URLSearchParams();
  if(req.query.message)params.set('message',String(req.query.message));
  if(req.query.error)params.set('error',String(req.query.error));
  return `/admin/servers${params.toString()?`?${params.toString()}`:''}#${anchor}`;
}
async function data(){
  const [settings,servers,plans]=await Promise.all([
    operations.get(),
    query(`SELECT id,name,server_class,health_status,COALESCE(placement_mode,'active') placement_mode,allow_new_users,max_users FROM jellyfin_servers WHERE enabled=TRUE ORDER BY priority,name`),
    query(`SELECT id,name,code,placement_strategy FROM plans WHERE active=TRUE AND archived_at IS NULL AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) ORDER BY sort_order,name`)
  ]);
  return{settings,servers:servers.rows,plans:plans.rows};
}
function placementEligible(server,settings){return server.placement_mode==='active'&&server.allow_new_users===true&&planServers.healthEligible(server,settings.placementHealthMode);}
function fleetState(d){
  const eligible=d.servers.filter(server=>placementEligible(server,d.settings));
  const offline=d.servers.filter(server=>server.health_status==='offline');
  const degraded=d.servers.filter(server=>server.health_status==='degraded');
  const paused=d.servers.filter(server=>server.placement_mode!=='active');
  const newUsersDisabled=d.servers.filter(server=>server.allow_new_users!==true);
  return{eligible,offline,degraded,paused,newUsersDisabled};
}
function fleetHero(d,state){return{enabled:d.servers.length,eligible:state.eligible.length,offline:state.offline.length,degraded:state.degraded.length,paused:state.paused.length};}
async function page(){return '/admin/servers#placement';}

function createAdminFleetOperationsRouter(){
  const r=express.Router();r.use('/admin/servers/operations',gate,noStore);
  r.get('/admin/servers/operations',(req,res)=>res.redirect(302,forward(req,'placement')));
  r.post('/admin/servers/operations/placement-policy',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const mode=['healthy_only','healthy_or_degraded','fail_open'].includes(req.body.placementHealthMode)?req.body.placementHealthMode:null;
      if(!mode)throw new Error('Choose a valid placement health policy.');
      await operations.patch({placementHealthMode:mode},req.session.authUserId);
      return res.redirect('/admin/servers?message='+encodeURIComponent('Placement health policy saved.')+'#placement-policy');
    }catch(error){return res.redirect('/admin/servers?error='+encodeURIComponent(error.message)+'#placement-policy');}
  });
  r.post('/admin/servers/operations/server/:id/placement-mode',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const mode=['active','drain','maintenance'].includes(req.body.mode)?req.body.mode:null;
      if(!mode)throw new Error('Unknown placement mode.');
      const result=await query(`UPDATE jellyfin_servers SET placement_mode=$2,updated_at=NOW() WHERE id=$1 RETURNING name`,[req.params.id,mode]);
      if(!result.rowCount)throw new Error('Server not found.');
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.server.placement_mode','jellyfin_server',$2,$3::jsonb)`,[req.session.authUserId,req.params.id,JSON.stringify({mode})]);
      return res.redirect(`/admin/servers?message=${encodeURIComponent(`${result.rows[0].name} placement mode is now ${mode}.`)}#server-${encodeURIComponent(req.params.id)}`);
    }catch(error){return res.redirect('/admin/servers?error='+encodeURIComponent(error.message)+'#placement');}
  });
  r.post('/admin/servers/operations/placement-preview',(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    const planId=String(req.body.planId||'').trim(),count=Math.max(1,Math.min(1000,Number(req.body.count)||25));
    const params=new URLSearchParams({previewPlanId:planId,previewCount:String(count)});
    return res.redirect(303,`/admin/servers?${params.toString()}#capacity-preview`);
  });
  return r;
}

module.exports={createAdminFleetOperationsRouter,page,data,fleetState,placementEligible,fleetHero};