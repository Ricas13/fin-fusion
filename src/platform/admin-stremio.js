'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');

const mutationLimit=routeRateLimit.middleware({scope:'admin-stremio-settings',max:20,windowSeconds:300});
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function target(message='',error=''){const q=new URLSearchParams();if(message)q.set('message',message);if(error)q.set('error',error);return `/admin/servers/stremio${q.toString()?`?${q}`:''}`;}
function queueIndex(){return query(`INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at,force_run_requested) VALUES('stremio_media_index',TRUE,21600,NOW(),TRUE) ON CONFLICT(job_key) DO UPDATE SET enabled=TRUE,next_run_at=NOW(),force_run_requested=TRUE,updated_at=NOW()`);}

function createAdminStremioRouter(){
  const router=express.Router();
  router.get('/admin/stremio-sources',gate,noStore,(_req,res)=>res.redirect(302,'/admin/servers/stremio'));
  router.use('/admin/settings/stremio',gate,noStore);
  router.get('/admin/settings/stremio',(_req,res)=>res.redirect(302,'/admin/servers/stremio'));
  // Compatibility only. Preserve old POST bookmarks/forms, but keep mutation
  // ownership in the canonical production-mounted Stremio server router.
  router.post('/admin/settings/stremio/runtime',(req,res)=>res.redirect(307,'/admin/servers/stremio/runtime'));
  router.post('/admin/settings/stremio/index',mutationLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await queueIndex();return res.redirect(target('Stremio indexing queued.'));}catch(error){return res.redirect(target('',error.message));}});
  router.post('/admin/settings/stremio/plans/:id',mutationLimit,(req,res)=>res.redirect(303,`/admin/plans/${encodeURIComponent(req.params.id)}/delivery?error=${encodeURIComponent('Stremio plan delivery is now managed from the plan Delivery page.')}`));
  router.post('/admin/settings/stremio/servers/:id',mutationLimit,(req,res)=>res.redirect(303,target('Managed Jellyfin Stremio eligibility is controlled from the Stremio page.')));
  return router;
}

module.exports={createAdminStremioRouter};
