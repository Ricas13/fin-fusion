'use strict';
const express=require('express');
const intents=require('../payments/checkout-intents');
const paypal=require('../payments/paypal');
const stripe=require('../payments/stripe');
const csrf=require('../auth/csrf');
const operations=require('./operations-settings');
const routeRateLimit=require('../security/route-rate-limit');
const paymentReturnLimit=routeRateLimit.middleware({scope:'customer-payment-return',max:30,windowSeconds:300});
const customerPortalLimit=routeRateLimit.middleware({scope:'customer-stripe-portal',max:10,windowSeconds:300});
function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'))}
async function absoluteUrl(req,path){return operations.absoluteUrl(req,path)}
function sameOrigin(){return false}
function mutationGuard(req,res,next){if(csrf.verify(req))return next();return res.status(403).send('Invalid or expired security token')}
function createCustomerPaymentReturnRouter(){const r=express.Router();r.get('/account/paypal/return',paymentReturnLimit,requireCustomer,async(req,res)=>{const intentId=String(req.query.checkout_intent||''),state=String(req.query.checkout_state||'');try{const row=await intents.verify({intentId,nonce:state,scope:'customer',provider:'paypal',ownerId:req.session.customerId});const providerId=String(row.checkout_mode==='payment'?(req.query.token||row.provider_checkout_id):(req.query.subscription_id||row.provider_checkout_id)||'');if(!providerId||String(row.provider_checkout_id)!==providerId)throw new Error('PayPal return does not match the checkout that was started.');if(row.checkout_mode==='payment')await paypal.captureOrder(providerId);else await paypal.activateSubscription(providerId);await intents.consume({intentId,nonce:state,providerCheckoutId:providerId,state:'completed',scope:'customer',provider:'paypal',ownerId:req.session.customerId});return res.redirect('/account?welcome=1&message='+encodeURIComponent('PayPal payment completed. Your access details are below.'))}catch(error){
    // The provider's own webhook can complete this same intent before the browser's
    // redirect gets here -- that means the payment already succeeded and access was
    // already activated, so don't show the customer a false "expired/already used" error.
    const already=await intents.alreadyCompletedByOwner({intentId,nonce:state,scope:'customer',provider:'paypal',ownerId:req.session.customerId}).catch(()=>null);
    if(already)return res.redirect('/account?welcome=1&message='+encodeURIComponent('PayPal payment completed. Your access details are below.'));
    return res.redirect('/account?error='+encodeURIComponent(error.message))}});r.post('/account/stripe/portal',customerPortalLimit,requireCustomer,mutationGuard,async(req,res)=>{try{const portal=await stripe.createCustomerPortal({customerId:req.session.customerId,returnUrl:await absoluteUrl(req,'/account')});return res.redirect(303,portal.url)}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message))}});return r}
module.exports={createCustomerPaymentReturnRouter,mutationGuard,sameOrigin,absoluteUrl};
