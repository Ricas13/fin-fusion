'use strict';
const express=require('express');
const csrf=require('../auth/csrf');
const reconciliation=require('../payments/incident-reconciliation');
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'?next():res.redirect('/login?session=expired')}
function createAdminPaymentReconciliationRouter(){const r=express.Router();
  // Compatibility only: the incident list and provider-reconciliation action
  // now live in Commerce so operators have one financial incident workflow.
  r.get('/admin/commerce/reconciliation',gate,(req,res)=>res.redirect(302,'/admin/commerce'));
  r.post('/admin/commerce/reconciliation/:id',gate,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const out=await reconciliation.reconcile(req.params.id,req.session.authUserId),message=out.match?`Provider event matched ${out.match.scope} subscription ${out.match.subscription_id}.`:`Provider event verified; no local subscription matched ${out.reference||'the returned reference'}.`;return res.redirect('/admin/commerce?message='+encodeURIComponent(message)+`#incident-${encodeURIComponent(req.params.id)}`)}catch(e){return res.redirect('/admin/commerce?error='+encodeURIComponent(e.message)+`#incident-${encodeURIComponent(req.params.id)}`)}});
  return r}
module.exports={createAdminPaymentReconciliationRouter};
