'use strict';

const express=require('express');
const capacity=require('../entitlements/reseller-tier-capacity');
const {query}=require('../db');

const CHECKED_PATHS=new Set(['/reseller/billing/stripe','/reseller/billing/paypal','/reseller/billing/tier']);
function redirectError(res,message){return res.redirect('/reseller?error='+encodeURIComponent(message));}
async function guard(req,res,next){
  try{
    const tierId=String(req.body?.tierId||'').trim();if(!tierId)return next();
    if(req.session?.authRole==='reseller'&&req.session?.authUserId){
      const current=await query(`SELECT rs.tier_id FROM reseller_subscriptions rs JOIN resellers r ON r.id=rs.reseller_id WHERE r.user_id=$1 AND rs.status IN('active','past_due') AND rs.current_period_end>NOW() ORDER BY rs.current_period_end DESC LIMIT 1`,[req.session.authUserId]);
      if(current.rowCount&&String(current.rows[0].tier_id)===tierId)return next();
    }
    await capacity.assertAvailable(tierId,{label:'This reseller plan'});return next();
  }catch(error){return redirectError(res,error.message||'This reseller plan is not available.');}
}
function createResellerCapacityGateRouter(){
  const r=express.Router();
  // This is a precondition middleware, not a second route owner. The mature
  // reseller portal remains the sole POST handler for these URLs; this layer
  // only rejects new acquisition before its provider code runs.
  r.use((req,res,next)=>{
    if(req.method!=='POST'||!CHECKED_PATHS.has(req.path))return next();
    return guard(req,res,next);
  });
  return r;
}
module.exports={createResellerCapacityGateRouter,guard,CHECKED_PATHS};
