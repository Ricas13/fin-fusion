'use strict';

const express=require('express');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='reseller'?next():res.redirect('/login?session=expired')}
function message(res,text='/reseller'){return res.redirect(`${text}?message=${encodeURIComponent('This reseller workspace now manages a monthly Jellyfin user allowance. Downstream sales, customer plans and legacy credits are no longer part of CAPTAiNFiN.')}`)}
function createResellerLegacyRouteRetirementRouter(){
  const r=express.Router();
  r.use('/reseller',gate);
  const retired=[
    '/reseller/sales',
    '/reseller/credit-history',
    '/reseller/ledger',
    '/reseller/owner/create',
    '/reseller/customer/create',
    '/reseller/customer/:id/renew',
    '/reseller/customer/:id/toggle',
    '/reseller/customer/:id/end-service',
    '/reseller/customer/:id/credentials',
    '/reseller/customer/:id/credentials/reset'
  ];
  for(const path of retired)r.all(path,(_req,res)=>message(res));
  return r;
}
module.exports={createResellerLegacyRouteRetirementRouter};
