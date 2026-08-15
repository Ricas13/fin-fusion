'use strict';

const express=require('express');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const resellerBilling=require('../payments/reseller-billing');
const providerSettings=require('../payments/provider-settings');
const checkoutIntents=require('../payments/checkout-intents');
function parse(raw){try{return JSON.parse(Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw||'{}'))}catch{return{}}}
const STRIPE_RISK=new Set(['charge.refunded','charge.dispute.created','charge.dispute.closed']);
const PAYPAL_RISK=new Set(['PAYMENT.SALE.REFUNDED','CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.RESOLVED']);
function paypalCheckoutCompletion(event){const resource=event?.resource||{};if(event?.event_type==='BILLING.SUBSCRIPTION.ACTIVATED')return resource.id||null;if(event?.event_type==='PAYMENT.SALE.COMPLETED')return resource.billing_agreement_id||null;return null}
function createWebhookRouter(){
 const router=express.Router();
 router.post('/webhooks/stripe',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{try{await providerSettings.ensureLoaded();if(!stripe.enabled())return res.status(404).end();const signature=req.get('stripe-signature');if(!signature)return res.status(400).send('Missing Stripe signature');const event=parse(req.body);if(STRIPE_RISK.has(event.type))await stripe.processWebhook(req.body,signature);else if(await resellerBilling.isStripeResellerEvent(req.body))await resellerBilling.processStripeWebhook(req.body,signature);else await stripe.processWebhook(req.body,signature);const object=event?.data?.object||{};if(event.type==='checkout.session.completed'&&object.id)await checkoutIntents.completeVerifiedProvider('stripe',object.id,'completed').catch(()=>{});if(event.type==='checkout.session.expired'&&object.id)await checkoutIntents.completeVerifiedProvider('stripe',object.id,'cancelled').catch(()=>{});return res.json({received:true})}catch(error){console.error('Stripe webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 router.post('/webhooks/paypal',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{try{await providerSettings.ensureLoaded();if(!paypal.enabled())return res.status(404).end();const event=parse(req.body);if(PAYPAL_RISK.has(event.event_type))await paypal.processWebhook(req.body,req.headers);else if(await resellerBilling.isPayPalResellerEvent(req.body))await resellerBilling.processPayPalWebhook(req.body,req.headers);else await paypal.processWebhook(req.body,req.headers);const providerId=paypalCheckoutCompletion(event);if(providerId)await checkoutIntents.completeVerifiedProvider('paypal',providerId,'completed').catch(()=>{});return res.json({received:true})}catch(error){console.error('PayPal webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 return router;
}
module.exports={createWebhookRouter,STRIPE_RISK,PAYPAL_RISK,paypalCheckoutCompletion};
