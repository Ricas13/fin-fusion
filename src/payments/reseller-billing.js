'use strict';
const previous=require('./reseller-billing-v2-core');
const legacy=require('./reseller-billing-core');
const intents=require('./checkout-intents');
async function activatePayPalCheckout({subscriptionId,intentId,state,resellerId=null}){const verified=await intents.verify({intentId,nonce:state,providerCheckoutId:subscriptionId,scope:'reseller',provider:'paypal',ownerId:resellerId||null});const activated=await legacy.activatePayPalSubscription(subscriptionId);const actual=activated?.reseller_id||verified.reseller_id;if(String(actual)!==String(verified.reseller_id))throw new Error('PayPal subscription does not match the reseller checkout.');await intents.consume({intentId,nonce:state,providerCheckoutId:subscriptionId,state:'completed',scope:'reseller',provider:'paypal',ownerId:verified.reseller_id});return activated}
module.exports={...previous,activatePayPalCheckout};
