'use strict';

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('Checkout commercial contract smoke')) process.exit(0);

const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const intents=require('../src/payments/checkout-intents');
// This smoke verifies the immutable commercial contract only. Provisioning has
// its own dedicated matrix and may legitimately be pending when no Jellyfin
// server is placeable, so do not make this contract test depend on a live fleet.
const provisioning=require('../src/jellyfin/resilient-provisioning');
provisioning.reconcileCustomer=async()=>({active:true,account:null});
const lifecycle=require('../src/payments/lifecycle');
const {addPlanDuration}=require('../src/payments/lifecycle-primitives');
const {commercialSnapshot}=require('../src/platform/flexible-checkout');
const {encryptWithEnv}=require('../src/security/purpose-crypto');

function expect(condition,message){if(!condition)throw new Error(message);}
async function expectReject(fn,pattern){let error=null;try{await fn();}catch(e){error=e;}if(!error)throw new Error('Expected operation to fail.');if(pattern&&!pattern.test(String(error.message||error)))throw error;}

// Checkout-intent creation itself checks fleet capacity (independent of the
// reconcileCustomer stub above), and fails closed for any jellyfin
// premium/free plan with no matching, enabled jellyfin_servers row -- add
// one so this contract test keeps depending only on the commercial contract,
// not a live fleet.
async function ensurePremiumServer(suffix){
    const apiKey=encryptWithEnv(`test-${suffix}`,'JELLYFIN_ENCRYPTION_KEY','jf1');
    return (await query(`
        INSERT INTO jellyfin_servers(
            name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,
            enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled,placement_mode
        )
        VALUES($1,$2,'premium','jellyfin','https://example.invalid','https://example.invalid',$3,
               TRUE,1,1000,'healthy',TRUE,TRUE,TRUE,'active')
        RETURNING id
    `,[`contract-server-${suffix}`,`contract-server-${suffix}`,apiKey])).rows[0].id;
}

async function main(){
    const suffix=crypto.randomBytes(4).toString('hex');
    await ensurePremiumServer(suffix);
    const customer=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`Contract ${suffix}`,`contract-${suffix}@example.invalid`])).rows[0];
    const plan=(await query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_live_tv,allow_live_tv_management,server_class,active,visible) VALUES($1,$2,'direct','month',30,600,'USD',3,TRUE,FALSE,FALSE,FALSE,FALSE,'premium',TRUE,TRUE) RETURNING *`,[`contract-${suffix}`,`Contract ${suffix}`])).rows[0];
    const mapping=`price_contract_${suffix}`;
    await query(`INSERT INTO plan_provider_prices(plan_id,provider,external_id,checkout_mode,active) VALUES($1,'stripe',$2,'payment',TRUE)`,[plan.id,mapping]);
    const choice={mode:'payment',planCode:plan.code,plan:{...plan,external_id:mapping}};
    const snapshot=commercialSnapshot(choice,'stripe');
    const intent=await intents.createIntent({scope:'customer',customerId:customer.id,planId:plan.id,provider:'stripe',checkoutMode:'payment',commercialSnapshot:snapshot});
    const providerCheckoutId=`cs_contract_${suffix}`;
    await intents.attachProviderCheckout(intent.id,providerCheckoutId);

    const verified=await intents.verifiedProviderContract({provider:'stripe',providerCheckoutId,scope:'customer',ownerId:customer.id,planId:plan.id,checkoutMode:'payment',providerMappingId:mapping,amountMinor:600,currency:'USD'});
    expect(verified.snapshot.priceMinor===600,'Checkout price was not snapshotted.');
    expect(verified.snapshot.streams===3,'Checkout stream policy was not snapshotted.');
    expect(verified.snapshot.allowDownloads===true,'Checkout download policy was not snapshotted.');
    await expectReject(()=>intents.verifiedProviderContract({provider:'stripe',providerCheckoutId,scope:'customer',ownerId:customer.id,planId:plan.id,checkoutMode:'payment',providerMappingId:mapping,amountMinor:601,currency:'USD'}),/amount/i);

    // Change and archive the catalogue after the customer has entered provider
    // checkout. Fulfilment must still use exactly what was sold above.
    await query(`UPDATE plans SET price_minor=9900,duration_days=365,streams=1,allow_downloads=FALSE,active=FALSE,visible=FALSE,archived_at=NOW(),updated_at=NOW() WHERE id=$1`,[plan.id]);
    const started=new Date();
    const subscription=await lifecycle.activatePurchase({customerId:customer.id,planId:plan.id,provider:'stripe',providerSubscriptionId:`pi_contract_${suffix}`,providerStatus:'active',periodStart:started,commercialSnapshot:verified.snapshot});
    // price_minor_snapshot is BIGINT in PostgreSQL; node-postgres intentionally
    // returns int8 values as strings unless a global parser is configured.
    expect(Number(subscription.price_minor_snapshot)===600,'Subscription price snapshot drifted to the edited catalogue.');
    expect(Number(subscription.duration_days_snapshot)===30,'Subscription duration snapshot drifted to the edited catalogue.');
    expect(subscription.commercial_snapshot?.streams===3,'Subscription lost the sold entitlement policy.');
    const expectedEnd=addPlanDuration(verified.snapshot,started);
    expect(new Date(subscription.current_period_end).getTime()===expectedEnd.getTime(),`One-time monthly entitlement did not end on the expected calendar-month boundary (${expectedEnd.toISOString()}).`);

    const effective=(await query(`SELECT * FROM effective_customer_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];
    expect(effective,'Canonical entitlement view did not return the activated purchase.');
    expect(Number(effective.price_minor)===600,'Canonical entitlement price ignored the checkout contract.');
    expect(Number(effective.streams)===3,'Canonical entitlement stream limit ignored the checkout contract.');
    expect(effective.allow_downloads===true,'Canonical entitlement download policy ignored the checkout contract.');
    expect(Number(effective.duration_days)===30,'Canonical entitlement duration ignored the checkout contract.');

    console.log('Checkout commercial contract smoke test passed.');
}

main().finally(()=>getPool().end());
