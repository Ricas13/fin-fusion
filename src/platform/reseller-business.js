'use strict';

const express=require('express');
const {query}=require('../db');
const {createResellerServiceAwarePortalRouter}=require('./reseller-service-aware-portal');
const {createResellerLegacyRouteRetirementRouter}=require('./reseller-legacy-route-retirement');

async function owner(userId){
  const result=await query(`SELECT r.id,u.username,u.email FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE r.user_id=$1`,[userId]);
  if(!result.rowCount)throw new Error('Reseller not found.');
  return result.rows[0];
}
function requestPath(req){try{return new URL(String(req.originalUrl||req.url||'/'),'http://captainfin.invalid').pathname}catch{return String(req.path||'')}}
function retiredGuard(_req,_res,next){return next()}
function createResellerBusinessRouter(){
  const r=express.Router();
  r.use(createResellerServiceAwarePortalRouter());
  r.use(createResellerLegacyRouteRetirementRouter());
  return r;
}
module.exports={createResellerBusinessRouter,owner,requestPath,saleReadinessGuard:retiredGuard,stremioCredentialGuard:retiredGuard};
