'use strict';

const express=require('express');
const capacity=require('../entitlements/reseller-tier-capacity');
const {query}=require('../db');

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
function createResellerCapacityGateRouter(){const r=express.Router();r.post('/reseller/billing/stripe',guard);r.post('/reseller/billing/paypal',guard);r.post('/reseller/billing/tier',guard);return r;}
module.exports={createResellerCapacityGateRouter,guard};
