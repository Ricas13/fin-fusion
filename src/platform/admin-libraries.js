'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const registry = require('../jellyfin/registry');
const { query } = require('../db');

function requireAdmin(req,res,next){
  if(req.session?.authUserId && req.session?.authRole==='admin' && req.session?.adminId) return next();
  return res.redirect('/login?session=expired');
}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}

async function libraryData(){
  const servers=await registry.listServers({enabledOnly:true});
  return Promise.all(servers.map(async server=>{
    try{
      const raw=await registry.request(server.id,'/Library/VirtualFolders',{timeoutMs:8000});
      const folders=Array.isArray(raw)?raw:[];
      return {server,ok:true,libraries:folders.map(v=>({name:v.Name||'Unnamed library',collectionType:v.CollectionType||'mixed',locations:Array.isArray(v.Locations)?v.Locations:[],itemId:v.ItemId||null}))};
    }catch(error){return {server,ok:false,error:'Library information could not be loaded from this server.',libraries:[]};}
  }));
}

function createAdminLibrariesRouter(){
  const router=express.Router();
  router.use('/admin/libraries',requireAdmin,noStore);
  router.post('/admin/libraries/:serverId/refresh',async(req,res)=>{
    if(!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
    try{
      await registry.request(req.params.serverId,'/Library/Refresh',{method:'POST',timeoutMs:8000});
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.library.refresh','jellyfin_server',$2,'{}'::jsonb)`,[req.session.authUserId,req.params.serverId]);
      return res.redirect(`/admin/servers?message=${encodeURIComponent('Library scan requested successfully.')}#server-${encodeURIComponent(req.params.serverId)}`);
    }catch(error){
      console.error('Library refresh failed:',error.message);
      return res.redirect(`/admin/servers?error=${encodeURIComponent('The library scan could not be started safely.')}#server-${encodeURIComponent(req.params.serverId)}`);
    }
  });
  router.use('/admin/libraries',(error,_req,res,_next)=>{console.error('Libraries route error:',error.message);return res.status(500).render('auth/message',{siteName:process.env.SITE_NAME||'CAPTAiNFiN',title:'Libraries unavailable',message:'Library information could not be loaded safely.',link:'/admin/servers',linkText:'Return to Servers'});});
  return router;
}

module.exports={createAdminLibrariesRouter,libraryData};