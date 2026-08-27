'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const {query}=require('../db');
const staffController=require('../auth/staff-controller');
const runtimeSettings=require('./runtime-settings');

function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[char]));}
function destroy(req){return new Promise(resolve=>{if(!req.session)return resolve();req.session.destroy(error=>{if(error)console.warn('Could not destroy logout session:',error.message);resolve();});});}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function customerSession(req){return Boolean(req.session?.customerUserId||req.session?.pendingCustomerAuth);}
function authenticatedSession(req){return Boolean(req.session?.authUserId||req.session?.customerUserId||req.session?.pendingStaffAuth||req.session?.pendingCustomerAuth);}

async function confirmation(req,res,next){
  try{
    if(!authenticatedSession(req))return res.redirect('/login');
    await runtimeSettings.ensureLoaded().catch(()=>{});
    const customer=customerSession(req),destination=customer?'/account':'/admin',site=runtimeSettings.siteName();
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Sign out · ${esc(site)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090d12;color:#dfe6ed;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(430px,calc(100% - 32px));padding:26px;border:1px solid #222b36;border-radius:14px;background:#121820}h1{margin:0 0 10px;font-size:22px}p{color:#8390a0;line-height:1.5}.actions{display:flex;gap:10px;margin-top:20px}.button{display:inline-flex;align-items:center;justify-content:center;padding:10px 15px;border:1px solid #2c3947;border-radius:8px;background:#17202a;color:#eaf1f7;text-decoration:none;font:inherit;cursor:pointer}.primary{background:#123d4d;border-color:#22657b}</style></head><body><main><h1>Sign out?</h1><p>This confirmation prevents link previews and browser prefetching from signing you out without an intentional action.</p><div class="actions"><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><button class="button primary" type="submit">Sign out</button></form><a class="button" href="${destination}">Cancel</a></div></main></body></html>`);
  }catch(error){return next(error);}
}

async function logout(req,res,next){
  if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
  const sid=req.sessionID,customerUserId=req.session?.customerUserId||null,isCustomer=customerSession(req);
  if(!isCustomer)return staffController.logout(req,res);
  try{
    if(customerUserId&&sid){
      await query(`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE session_id=$1 AND user_id=$2 AND role='customer'`,[sid,customerUserId]);
    }
  }catch(error){
    console.warn('Could not record customer logout:',error.message);
  }
  try{
    await destroy(req);
    res.clearCookie(process.env.SESSION_COOKIE_NAME||'steamfusion.sid',{path:'/'});
    return res.redirect('/account/login');
  }catch(error){return next(error);}
}

function createLogoutRouter(){
  const router=express.Router();
  router.use('/logout',noStore);
  router.get('/logout',confirmation);
  router.post('/logout',logout);
  return router;
}

module.exports={createLogoutRouter,confirmation,logout,customerSession,authenticatedSession};
