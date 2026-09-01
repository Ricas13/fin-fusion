'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const tickets=require('../support/tickets');
const supportNotifications=require('../support/notifications');
const runtimeSettings=require('./runtime-settings');
const operations=require('./operations-settings');
const customerNav=require('./customer-nav-html');

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/support'));}
function message(req){return{message:req.query.message||null,error:req.query.error||null};}
async function adminTicketUrl(req,ticketId){try{return await operations.absoluteUrl(req,`/admin/tickets/${ticketId}`);}catch{return null;}}
async function notifyStaff(req,{ticket,messageId,kind,content=''}){
  try{
    return await supportNotifications.queueNeedsStaff({ticket,messageId,kind,content,ticketUrl:await adminTicketUrl(req,ticket.id)});
  }catch(error){
    console.warn('Support staff notification could not be queued:',String(error?.message||error).replace(/[\r\n]/g,' ').slice(0,300));
    return null;
  }
}
function createCustomerSupportRouter(){
  const router=express.Router();
  router.use('/account/support',requireCustomer);
  router.get('/account/support',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const [rows,navOptions]=await Promise.all([tickets.listForCustomer(req.session.customerId),customerNav.optionsForCustomer(req.session.customerId)]);return res.render('customer/support',{siteName:runtimeSettings.siteName(),tickets:rows,navOptions,csrfToken:csrf.token(req),...message(req)});}catch(error){next(error)}});
  router.post('/account/support',async(req,res)=>{
    if(!csrf.verify(req))return res.redirect('/account/support?error='+encodeURIComponent('Invalid or expired security token.'));
    try{
      const ticket=await tickets.create({customerId:req.session.customerId,customerUserId:req.session.customerUserId,subject:req.body.subject,category:req.body.category,message:req.body.message});
      await notifyStaff(req,{ticket,messageId:ticket.initial_message_id,kind:'created',content:req.body.message});
      return res.redirect(`/account/support/${ticket.id}?message=${encodeURIComponent(`Ticket #${ticket.ticket_number} created.`)}`);
    }catch(error){return res.redirect('/account/support?error='+encodeURIComponent(error.message));}
  });
  router.get('/account/support/:id',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const [data,navOptions]=await Promise.all([tickets.getForCustomer(req.params.id,req.session.customerId),customerNav.optionsForCustomer(req.session.customerId)]);if(!data)return res.redirect('/account/support?error='+encodeURIComponent('This support ticket does not exist or is not linked to your account.'));return res.render('customer/support-thread',{siteName:runtimeSettings.siteName(),navOptions,csrfToken:csrf.token(req),...data,...message(req)});}catch(error){next(error)}});
  router.post('/account/support/:id/reply',async(req,res)=>{
    if(!csrf.verify(req))return res.redirect(`/account/support/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent('Invalid or expired security token.')}`);
    try{
      const reply=await tickets.replyCustomer({ticketId:req.params.id,customerId:req.session.customerId,customerUserId:req.session.customerUserId,message:req.body.message});
      await notifyStaff(req,{ticket:reply.ticket,messageId:reply.messageId,kind:'reply',content:req.body.message});
      return res.redirect(`/account/support/${req.params.id}?message=${encodeURIComponent('Reply sent.')}`);
    }catch(error){return res.redirect(`/account/support/${req.params.id}?error=${encodeURIComponent(error.message)}`);}
  });
  return router;
}
module.exports={createCustomerSupportRouter,requireCustomer,notifyStaff,adminTicketUrl};