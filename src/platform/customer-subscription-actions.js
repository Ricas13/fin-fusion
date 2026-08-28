'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const billingControl = require('../payments/billing-control');
const planChange = require('../payments/customer-plan-change');
const routeRateLimit = require('../security/route-rate-limit');
const publicError = require('./public-error');
const subscriptionActionLimit = routeRateLimit.middleware({scope:'customer-subscription-action',max:20,windowSeconds:3600});
const SUBSCRIPTION_ACTION_SAFE=['No active recurring subscription was found.','Unknown renewal action.','There is no pending plan change to cancel.'];
function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'))}
function guard(req,res,next){if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');return next()}
function redirect(res,key,message){return res.redirect(`/account?${key}=${encodeURIComponent(message)}`)}
function errorRedirect(res,error,context,fallback){const{message}=publicError.present(error,{context,fallback,safe:SUBSCRIPTION_ACTION_SAFE});return redirect(res,'error',message)}
async function currentRecurringOwned(customerId){const current=await planChange.currentRecurring(customerId);if(!current)throw new Error('No active recurring subscription was found.');return current}
function createCustomerSubscriptionActionsRouter(){const r=express.Router();r.use('/account/subscription',requireCustomer);r.use('/account/plan-change',requireCustomer);
 r.post('/account/subscription/renewal',subscriptionActionLimit,guard,async(req,res)=>{try{const current=await currentRecurringOwned(req.session.customerId),enable=String(req.body.action||'')==='resume';if(!['stop','resume'].includes(String(req.body.action||'')))throw new Error('Unknown renewal action.');await billingControl.setRenewal(current.subscription_id||current.id,enable,req.session.customerUserId);return redirect(res,'message',enable?'Automatic renewal resumed.':'Automatic renewal stopped. Your paid access remains active until the current period ends.')}catch(error){return errorRedirect(res,error,'Renewal toggle failed','Renewal could not be changed.')}});
 r.post('/account/plan-change/cancel',subscriptionActionLimit,guard,async(req,res)=>{try{const cancelled=await planChange.cancelPendingChange(req.session.customerId,req.session.customerUserId);return redirect(res,'message',`Scheduled plan target cancelled${cancelled.effective_at?` before ${new Date(cancelled.effective_at).toLocaleDateString('en-GB')}`:''}.${cancelled.warning||''}`)}catch(error){return errorRedirect(res,error,'Plan-change cancel failed','Plan change could not be cancelled.')}});return r}
module.exports={createCustomerSubscriptionActionsRouter,currentRecurringOwned,SUBSCRIPTION_ACTION_SAFE};
