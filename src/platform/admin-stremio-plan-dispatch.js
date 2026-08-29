'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const runtimeSettings=require('./runtime-settings');
const editor=require('./admin-stremio-plan-editor');

const editorWriteLimit=routeRateLimit.middleware({scope:'admin-stremio-plan-editor',max:30,windowSeconds:60,reason:'admin_stremio_plan_editor'});
const CARD_POSTS=new Map([
  ['editor-commerce',{handler:editor.saveCommerce,message:'Plan, storefront & commerce saved.',anchor:'commerce'}],
  ['editor-storefront',{handler:editor.saveStorefront,message:'Storefront saved.',anchor:'commerce'}],
  ['editor-access',{handler:editor.saveAccess,message:'Access policy saved.',anchor:'access'}],
  ['editor-availability',{handler:editor.saveAvailability,message:'Availability saved.',anchor:'availability'}],
  ['editor-payments',{handler:editor.savePayments,message:'Payment options verified and saved.',anchor:'commerce'}]
]);

function gate(req,res,next){
  return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId
    ? next()
    : res.redirect('/login?session=expired');
}
function noStore(_req,res,next){
  res.setHeader('Cache-Control','no-store, private, max-age=0');
  res.setHeader('Pragma','no-cache');
  next();
}
function decodePlanId(value){
  try{return decodeURIComponent(value);}catch{return value;}
}
function runLimited(limit,req,res,next,handler){
  return limit(req,res,error=>{
    if(error)return next(error);
    Promise.resolve().then(handler).catch(next);
  });
}
function cardRedirect(res,planId,kind,message,anchor=''){
  return res.redirect(`/admin/plans/${encodeURIComponent(planId)}/edit?${kind}=${encodeURIComponent(message)}${anchor?`#${anchor}`:''}`);
}
function updateSuffix(result){
  return result?.updatedSubscriptions
    ? ` ${result.updatedSubscriptions} live subscriber${result.updatedSubscriptions===1?' was':'s were'} updated and household leases reset.`
    : '';
}

async function editGet(req,res,next,planId){
  await runtimeSettings.ensureLoaded();
  const data=await editor.loadData(planId);
  if(!data)return res.status(404).send('Plan not found');
  if(String(data.plan.service_type)!=='stremio')return next();
  return res.send(editor.page(data,req));
}

async function legacyGet(req,res,next,planId){
  const data=await editor.loadData(planId);
  if(!data)return next();
  if(String(data.plan.service_type)!=='stremio')return next();
  const params=new URLSearchParams();
  for(const key of ['message','error']){
    const value=Array.isArray(req.query?.[key])?req.query[key][0]:req.query?.[key];
    if(value)params.set(key,String(value).slice(0,1000));
  }
  const queryString=params.toString();
  return res.redirect(302,`/admin/plans/${encodeURIComponent(planId)}/edit${queryString?`?${queryString}`:''}`);
}

async function cardPost(req,res,next,planId,action){
  await runtimeSettings.ensureLoaded();
  const data=await editor.loadData(planId);
  if(!data||String(data.plan.service_type)!=='stremio')return next();
  const spec=CARD_POSTS.get(action);
  if(!spec)return next();
  return runLimited(editorWriteLimit,req,res,next,async()=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const result=await spec.handler(req,data);
      return cardRedirect(res,data.plan.id,'message',spec.message+updateSuffix(result),spec.anchor);
    }catch(error){
      return cardRedirect(res,data.plan.id,'error',error.message||'Plan could not be updated.',spec.anchor);
    }
  });
}

async function editPost(req,res,next,planId){
  if(!csrf.verify(req))return res.status(403).send('Invalid security token');
  await runtimeSettings.ensureLoaded();
  const data=await editor.loadData(planId);
  if(!data)return res.status(404).send('Plan not found');
  if(String(data.plan.service_type)!=='stremio')return res.status(400).send('This editor is only available for Stremio plans.');
  try{
    const input=editor.parse(req.body||{});
    const impact=editor.householdImpact(data.plan,input);
    const scope=String(req.body?.impactScope||'');
    if(data.live&&impact.restrictive&&!['new_only','existing'].includes(scope)){
      return res.status(409).send(editor.page(data,req,{input:req.body,impact}));
    }
    const result=await editor.save(data,input,scope,req.session.authUserId);
    const suffix=result.impact.restrictive&&scope==='new_only'
      ? ' Existing subscriptions kept their previous household policy.'
      : result.updatedSubscriptions
        ? ` ${result.updatedSubscriptions} active subscription${result.updatedSubscriptions===1?' was':'s were'} updated.`
        : '';
    return res.redirect(`/admin/plans/${encodeURIComponent(planId)}/edit?message=${encodeURIComponent(`Stremio plan saved.${suffix}`)}`);
  }catch(error){
    return res.status(400).send(editor.page(data,req,{input:req.body,error:error.message}));
  }
}

function createAdminStremioPlanDispatchRouter(){
  const router=express.Router();
  router.use('/admin/plans',gate,noStore);
  router.use((req,res,next)=>{
    const pathname=req.path;
    // Creation deliberately falls through to admin-plan-create-v2 so Jellyfin
    // Free, Jellyfin Paid and Stremio share one canonical adaptive workflow.
    // This dispatcher owns Stremio edit-page reads and every form rendered by
    // that page before the shared Jellyfin/legacy route owners can match them.
    let match=pathname.match(/^\/admin\/plans\/([^/]+)\/edit$/);
    if(req.method==='GET'&&match){
      return Promise.resolve(editGet(req,res,next,decodePlanId(match[1]))).catch(next);
    }
    match=pathname.match(/^\/admin\/plans\/([^/]+)\/(?:access|delivery|stremio)$/);
    if(req.method==='GET'&&match){
      return Promise.resolve(legacyGet(req,res,next,decodePlanId(match[1]))).catch(next);
    }
    match=pathname.match(/^\/admin\/plans\/([^/]+)\/(editor-commerce|editor-storefront|editor-access|editor-availability|editor-payments)$/);
    if(req.method==='POST'&&match){
      return Promise.resolve(cardPost(req,res,next,decodePlanId(match[1]),match[2])).catch(next);
    }
    match=pathname.match(/^\/admin\/plans\/([^/]+)\/stremio-editor$/);
    if(req.method==='POST'&&match){
      return runLimited(editorWriteLimit,req,res,next,()=>editPost(req,res,next,decodePlanId(match[1])));
    }
    return next();
  });
  return router;
}

module.exports={createAdminStremioPlanDispatchRouter,cardPost};
