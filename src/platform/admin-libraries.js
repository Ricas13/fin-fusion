'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const auth = require('../auth/service');
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
    }catch(error){
      return {server,ok:false,error:'Library information could not be loaded from this server.',libraries:[]};
    }
  }));
}

function createAdminLibrariesRouter(){
  const router=express.Router();
  router.use('/admin/libraries',requireAdmin,noStore);
  router.get('/admin/libraries',async(req,res,next)=>{
    try{return res.render('admin/libraries',{siteName:process.env.SITE_NAME||'CAPTaINFiN',activeNav:'libraries',groups:await libraryData(),csrfToken:csrf.token(req),message:req.query.message||null,error:req.query.error||null});}
    catch(error){return next(error);}
  });
  router.post('/admin/libraries/:serverId/refresh',async(req,res)=>{
    if(!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
    try{
      if(!(await auth.verifySecondFactor(req.session.authUserId,req.body.code,req))) return res.redirect('/admin/libraries?error='+encodeURIComponent('Second-factor verification failed. No library scan was started.'));
      await registry.request(req.params.serverId,'/Library/Refresh',{method:'POST',timeoutMs:8000});
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.library.refresh','jellyfin_server',$2,'{}'::jsonb)`,[req.session.authUserId,req.params.serverId]);
      return res.redirect('/admin/libraries?message='+encodeURIComponent('Library scan requested successfully.'));
    }catch(error){console.error('Library refresh failed:',error.message);return res.redirect('/admin/libraries?error='+encodeURIComponent('The library scan could not be started safely.'))}
  });
  router.use('/admin/libraries',(error,_req,res,_next)=>{console.error('Libraries route error:',error.message);return res.status(500).render('auth/message',{siteName:process.env.SITE_NAME||'CAPTaINFiN',title:'Libraries unavailable',message:'Library information could not be loaded safely.',link:'/admin',linkText:'Return to Administration'});});
  return router;
}

module.exports={createAdminLibrariesRouter,libraryData};
