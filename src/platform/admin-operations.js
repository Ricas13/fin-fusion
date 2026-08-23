'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const {query}=require('../db');
const operations=require('./operations-settings');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function forwardQuery(req,target){const params=new URLSearchParams();if(req.query.message)params.set('message',String(req.query.message));if(req.query.error)params.set('error',String(req.query.error));const qs=params.toString();return `${target}${qs?`?${qs}`:''}`;}

// Operations used to be a catch-all page for unrelated platform, security and
// server controls. Keep its endpoints for stale tabs/configuration automation,
// but normal operators are redirected to the workflows that now own them.
function createAdminOperationsRouter(){
  const r=express.Router();r.use('/admin/operations',gate,noStore);
  r.get('/admin/operations',(req,res)=>res.redirect(302,forwardQuery(req,'/admin/servers')));
  r.post('/admin/operations',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await operations.save(req.body,req.session.authUserId);return res.redirect('/admin/settings?section=general&message='+encodeURIComponent('Legacy operational settings saved. Platform URL/locale are under General, security limits under Security, and placement is configured directly on Servers.'));}catch(error){return res.redirect('/admin/settings?section=general&error='+encodeURIComponent(error.message));}});
  r.post('/admin/operations/activation-cleanup',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const value={enabled:req.body.enabled==='on',retentionDays:Math.max(7,Math.min(365,Number(req.body.retentionDays)||30)),warningDays:Math.max(1,Math.min(30,Number(req.body.warningDays)||7))};if(value.warningDays>=value.retentionDays)throw new Error('Warning window must be shorter than the retention period.');await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by) VALUES('activation_cleanup_v1',$1::jsonb,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[JSON.stringify(value),req.session.authUserId]);return res.redirect('/admin/settings?section=security&message='+encodeURIComponent('Abandoned activation cleanup policy saved.'));}catch(error){return res.redirect('/admin/settings?section=security&error='+encodeURIComponent(error.message));}});
  r.post('/admin/operations/server/:id/placement-mode',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const mode=['active','drain','maintenance'].includes(req.body.mode)?req.body.mode:null;if(!mode)throw new Error('Unknown placement mode.');const result=await query(`UPDATE jellyfin_servers SET placement_mode=$2,updated_at=NOW() WHERE id=$1 RETURNING name`,[req.params.id,mode]);if(!result.rowCount)throw new Error('Server not found.');return res.redirect('/admin/servers?message='+encodeURIComponent(`${result.rows[0].name} placement mode is now ${mode}.`)+'#server-'+encodeURIComponent(req.params.id));}catch(error){return res.redirect('/admin/servers?error='+encodeURIComponent(error.message)+'#placement');}});
  r.post('/admin/operations/placement-preview',(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');return res.redirect(303,'/admin/servers#capacity-preview');});
  return r;
}

module.exports={createAdminOperationsRouter};