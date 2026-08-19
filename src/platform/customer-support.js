'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const tickets=require('../support/tickets');
const runtimeSettings=require('./runtime-settings');

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/support'));}
function message(req){return{message:req.query.message||null,error:req.query.error||null};}
function createCustomerSupportRouter(){
  const router=express.Router();
  router.use('/account/support',requireCustomer);
  router.get('/account/support',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const rows=await tickets.listForCustomer(req.session.customerId);return res.render('customer/support',{siteName:runtimeSettings.siteName(),tickets:rows,csrfToken:csrf.token(req),...message(req)});}catch(error){next(error)}});
  router.post('/account/support',async(req,res)=>{
    if(!csrf.verify(req))return res.redirect('/account/support?error='+encodeURIComponent('Invalid or expired security token.'));
    try{const ticket=await tickets.create({customerId:req.session.customerId,customerUserId:req.session.customerUserId,subject:req.body.subject,category:req.body.category,message:req.body.message});return res.redirect(`/account/support/${ticket.id}?message=${encodeURIComponent(`Ticket #${ticket.ticket_number} created.`)}`);}catch(error){return res.redirect('/account/support?error='+encodeURIComponent(error.message));}
  });
  router.get('/account/support/:id',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const data=await tickets.getForCustomer(req.params.id,req.session.customerId);if(!data)return res.status(404).send('Ticket not found');return res.render('customer/support-thread',{siteName:runtimeSettings.siteName(),csrfToken:csrf.token(req),...data,...message(req)});}catch(error){next(error)}});
  router.post('/account/support/:id/reply',async(req,res)=>{
    if(!csrf.verify(req))return res.redirect(`/account/support/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent('Invalid or expired security token.')}`);
    try{await tickets.replyCustomer({ticketId:req.params.id,customerId:req.session.customerId,customerUserId:req.session.customerUserId,message:req.body.message});return res.redirect(`/account/support/${req.params.id}?message=${encodeURIComponent('Reply sent.')}`);}catch(error){return res.redirect(`/account/support/${req.params.id}?error=${encodeURIComponent(error.message)}`);}
  });
  return router;
}
module.exports={createCustomerSupportRouter,requireCustomer};
