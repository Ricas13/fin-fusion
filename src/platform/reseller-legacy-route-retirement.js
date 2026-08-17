'use strict';

const express=require('express');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='reseller'?next():res.redirect('/login?session=expired')}
function message(res,text='/reseller'){return res.redirect(`${text}?message=${encodeURIComponent('This reseller workspace now manages a monthly Jellyfin user allowance. Downstream sales, customer plans and legacy credits are no longer part of CAPTAiNFiN.')}`)}
function createResellerLegacyRouteRetirementRouter(){
  const r=express.Router();
  r.use('/reseller',gate);
  // The active managed-user portal owns the common historical entry points
  // (sales, ledger, credit history, customer create/renew) so it can give the
  // most contextual redirect. This router owns only the remaining retired
  // customer-operation URLs; each route therefore has one assembled owner.
  const retired=[
    '/reseller/owner/create',
    '/reseller/customer/:id/toggle',
    '/reseller/customer/:id/end-service',
    '/reseller/customer/:id/credentials',
    '/reseller/customer/:id/credentials/reset'
  ];
  for(const path of retired)r.all(path,(_req,res)=>message(res));
  return r;
}
module.exports={createResellerLegacyRouteRetirementRouter};
