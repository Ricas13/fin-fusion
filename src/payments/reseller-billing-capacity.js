'use strict';

const previous=require('./reseller-billing');
const capacity=require('../entitlements/reseller-tier-capacity');

async function assertTier(tierId){return capacity.assertAvailable(tierId,{label:'This reseller plan'});}
async function createStripeCheckout(input){await assertTier(input.tierId);return previous.createStripeCheckout(input);}
async function createPayPalCheckout(input){await assertTier(input.tierId);return previous.createPayPalCheckout(input);}
async function requestTierChange(resellerId,tierId){await assertTier(tierId);return previous.requestTierChange(resellerId,tierId);}

// Provider callbacks/webhooks deliberately remain delegated without a capacity
// re-check. Once checkout has been authorised, fulfilment must be idempotent and
// must not strand a payer because the public inventory changed milliseconds later.
module.exports={...previous,createStripeCheckout,createPayPalCheckout,requestTierChange};
