'use strict';

const express=require('express');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const plisio=require('../payments/plisio');
const providerSettings=require('../payments/provider-settings');
const {requestMaintenanceGuard}=require('../security/maintenance-lock');
const STRIPE_RISK=new Set(['charge.refunded','charge.dispute.created','charge.dispute.closed']);
const PAYPAL_RISK=new Set(['PAYMENT.SALE.REFUNDED','CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.RESOLVED']);
const PLISIO_RISK=new Set();
function createWebhookRouter(){
 const router=express.Router();
 router.post('/webhooks/stripe',express.raw({type:'application/json',limit:'1mb'}),requestMaintenanceGuard,async(req,res)=>{try{await providerSettings.ensureLoaded();if(!stripe.enabled())return res.status(404).end();const signature=req.get('stripe-signature');if(!signature)return res.status(400).send('Missing Stripe signature');await stripe.processWebhook(req.body,signature);return res.json({received:true})}catch(error){console.error('Stripe webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 router.post('/webhooks/paypal',express.raw({type:'application/json',limit:'1mb'}),requestMaintenanceGuard,async(req,res)=>{try{await providerSettings.ensureLoaded();if(!paypal.enabled())return res.status(404).end();await paypal.processWebhook(req.body,req.headers);return res.json({received:true})}catch(error){console.error('PayPal webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 router.post('/webhooks/plisio',express.raw({type:'*/*',limit:'1mb'}),requestMaintenanceGuard,async(req,res)=>{try{await providerSettings.ensureLoaded();if(!plisio.enabled())return res.status(404).end();await plisio.processWebhook(req.body,req.get('content-type')||'');return res.status(200).send('OK')}catch(error){console.error('Plisio webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 return router;
}
module.exports={createWebhookRouter,STRIPE_RISK,PAYPAL_RISK,PLISIO_RISK};
