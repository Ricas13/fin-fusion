'use strict';

const express=require('express');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const resellerBilling=require('../payments/reseller-billing');
const providerSettings=require('../payments/provider-settings');
const checkoutIntents=require('../payments/checkout-intents');
function parse(raw){try{return JSON.parse(Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw||'{}'))}catch{return{}}}
function createWebhookRouter(){const router=express.Router();router.post('/webhooks/stripe',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{try{await providerSettings.ensureLoaded();if(!stripe.enabled())return res.status(404).end();const signature=req.get('stripe-signature');if(!signature)return res.status(400).send('Missing Stripe signature');const reseller=await resellerBilling.isStripeResellerEvent(req.body);if(reseller)await resellerBilling.processStripeWebhook(req.body,signature);else await stripe.processWebhook(req.body,signature);const event=parse(req.body),object=event?.data?.object||{};if(event.type==='checkout.session.completed'&&object.id)await checkoutIntents.completeVerifiedProvider('stripe',object.id,'completed').catch(()=>{});if(event.type==='checkout.session.expired'&&object.id)await checkoutIntents.completeVerifiedProvider('stripe',object.id,'cancelled').catch(()=>{});return res.json({received:true})}catch(error){console.error('Stripe webhook error:',error.message);return res.status(400).send('Webhook rejected')}});router.post('/webhooks/paypal',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{try{await providerSettings.ensureLoaded();if(!paypal.enabled())return res.status(404).end();if(await resellerBilling.isPayPalResellerEvent(req.body))await resellerBilling.processPayPalWebhook(req.body,req.headers);else await paypal.processWebhook(req.body,req.headers);return res.json({received:true})}catch(error){console.error('PayPal webhook error:',error.message);return res.status(400).send('Webhook rejected')}});return router}
module.exports={createWebhookRouter};
