'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, transaction, getPool } = require('../src/db');
const discounts = require('../src/payments/discounts');
const intents = require('../src/payments/checkout-intents');
const lifecycle = require('../src/payments/lifecycle');
const providerOps = require('../src/payments/provider-operations');
const { encryptWithEnv } = require('../src/security/purpose-crypto');

const suffix = crypto.randomBytes(6).toString('hex');
const code = name => `race-${name}-${suffix}`;
const email = name => `race-${name}-${suffix}@example.invalid`;

// Fleet capacity fails closed for any jellyfin premium/free plan with no
// matching, enabled jellyfin_servers row (see plan-capacity.js's fleetPlan
// gate) -- without this, every checkout intent below (and the canonical
// Free Access claim race, which is on the 'free' class) is rejected as sold
// out before the concurrency/race assertions this file exists for ever run.
async function ensureFleetServers() {
    const apiKey = encryptWithEnv(`test-${suffix}`, 'JELLYFIN_ENCRYPTION_KEY', 'jf1');
    for (const serverClass of ['premium', 'free']) {
        await query(`
            INSERT INTO jellyfin_servers(
                name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,
                enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled,placement_mode
            )
            VALUES($1,$2,$3,'jellyfin','https://example.invalid','https://example.invalid',$4,
                   TRUE,1,1000,'healthy',TRUE,TRUE,TRUE,'active')
        `, [`race-server-${serverClass}-${suffix}`, `race-server-${serverClass}-${suffix}`, serverClass, apiKey]);
    }
}

async function plan(name,{price=500,audience='direct',interval='month',streams=2}={}) {
    return (await query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
        VALUES($1,$2,$3,$4,30,$5,'GBP',$6,'premium',TRUE,TRUE) RETURNING *`,
        [code(name),`Race ${name} ${suffix}`,audience,interval,price,streams])).rows[0];
}
async function customer(name) {
    return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,
        [`Race ${name} ${suffix}`,email(name)])).rows[0];
}
function snapshot(p,provider='stripe',checkoutMode='payment') {
    return {kind:'direct_plan',planId:p.id,planCode:p.code,planName:p.name,provider,checkoutMode,
        providerMappingId:`price_${suffix}`,priceMinor:Number(p.price_minor),discountedMinor:Number(p.price_minor),
        currency:String(p.currency).trim(),billingInterval:p.billing_interval,durationDays:Number(p.duration_days),streams:Number(p.streams),
        allowDownloads:false,allowVideoTranscoding:false,allowAudioTranscoding:false,allowLiveTv:false,allowLiveTvManagement:false,serverClass:p.server_class};
}

async function lastDiscountUse() {
    const p=await plan('discount'),a=await customer('discount-a'),b=await customer('discount-b');
    const ia=await intents.createIntent({scope:'customer',customerId:a.id,planId:p.id,provider:'stripe',checkoutMode:'payment',commercialSnapshot:snapshot(p)});
    const ib=await intents.createIntent({scope:'customer',customerId:b.id,planId:p.id,provider:'stripe',checkoutMode:'payment',commercialSnapshot:snapshot(p)});
    // Real discount creation normalizes codes before persistence. This fixture
    // inserts directly into PostgreSQL, so mirror that invariant explicitly or
    // both racers are rejected as an invalid mixed-case code before contention.
    const lastOne=discounts.normalizeCode(code('LASTONE'));
    await query(`INSERT INTO discount_codes(code,discount_type,percent_off,max_redemptions,per_customer_limit,active) VALUES($1,'percent',10,1,1,TRUE)`,[lastOne]);
    const attempts=await Promise.allSettled([
        discounts.reserveForIntent({code:lastOne,planCode:p.code,customerId:a.id,checkoutIntentId:ia.id,baseMinor:p.price_minor}),
        discounts.reserveForIntent({code:lastOne,planCode:p.code,customerId:b.id,checkoutIntentId:ib.id,baseMinor:p.price_minor})
    ]);
    assert.strictEqual(attempts.filter(x=>x.status==='fulfilled').length,1,'Concurrent last-use discount allowed more than one reservation');
    assert.strictEqual(attempts.filter(x=>x.status==='rejected').length,1,'Concurrent last-use discount did not reject the losing reservation');
    const count=await query(`SELECT COUNT(*)::int n FROM discount_checkout_reservations r JOIN discount_codes d ON d.id=r.discount_code_id WHERE d.code=$1 AND r.state='reserved'`,[lastOne]);
    assert.strictEqual(Number(count.rows[0].n),1,'Discount reservation cap is not reflected in persisted state');
}

async function freeClaimRace() {
    const free=await query(`UPDATE plans SET capacity_limit=1,updated_at=NOW() WHERE is_free_tier=TRUE RETURNING *`);
    assert.strictEqual(free.rowCount,1,'Fresh database must contain exactly one canonical Free Access plan');
    const p=free.rows[0],c=await customer('free');
    const results=await Promise.allSettled([lifecycle.claimFreePlan(c.id,p.code),lifecycle.claimFreePlan(c.id,p.code)]);
    assert.strictEqual(results.filter(x=>x.status==='fulfilled').length,1,'Concurrent free claim must produce exactly one successful claim');
    assert.strictEqual(results.filter(x=>x.status==='rejected').length,1,'Concurrent free claim must reject the duplicate claim');
    const count=await query(`SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND source='free_claim'`,[c.id,p.id]);
    assert.strictEqual(Number(count.rows[0].n),1,'Concurrent free claim persisted duplicate subscriptions');
    const persisted=await query(`SELECT current_period_end FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND source='free_claim'`,[c.id,p.id]);
    assert(new Date(persisted.rows[0].current_period_end).getUTCFullYear()===9999,'Canonical Free Access claim must be non-expiring');
}

async function checkoutSurvivesCatalogueRetirement() {
    const p=await plan('contract'),c=await customer('contract'),commercial=snapshot(p);
    const intent=await intents.createIntent({scope:'customer',customerId:c.id,planId:p.id,provider:'stripe',checkoutMode:'payment',commercialSnapshot:commercial});
    const providerCheckout=`cs_race_${suffix}`;
    await intents.attachProviderCheckout(intent.id,providerCheckout);
    await query(`UPDATE plans SET active=FALSE,visible=FALSE,archived_at=NOW(),name='Retired after checkout',price_minor=9999 WHERE id=$1`,[p.id]);
    const verified=await intents.verifiedProviderContract({provider:'stripe',providerCheckoutId:providerCheckout,scope:'customer',ownerId:c.id,planId:p.id,checkoutMode:'payment',providerMappingId:commercial.providerMappingId,amountMinor:commercial.priceMinor,currency:commercial.currency});
    assert.strictEqual(verified.snapshot.planName,commercial.planName,'Committed checkout followed a later catalogue edit');
    assert.strictEqual(Number(verified.snapshot.priceMinor),Number(commercial.priceMinor),'Committed checkout price followed a later catalogue edit');
    const completed=await intents.completeVerifiedProvider('stripe',providerCheckout,'completed');
    assert.strictEqual(completed.state,'completed','Committed checkout could not complete after catalogue retirement');
}

async function duplicateAndOutOfOrderProviderEvents() {
    const eventId=`evt_race_${suffix}`;
    const leases=await Promise.all([
        lifecycle.beginPaymentEvent({provider:'stripe',eventId,eventType:'invoice.paid',payload:{id:eventId}}),
        lifecycle.beginPaymentEvent({provider:'stripe',eventId,eventType:'invoice.paid',payload:{id:eventId}})
    ]);
    assert.strictEqual(leases.filter(Boolean).length,1,'Duplicate provider event acquired more than one processing lease');
    await lifecycle.finishPaymentEvent(leases.find(Boolean));
    const duplicate=await lifecycle.beginPaymentEvent({provider:'stripe',eventId,eventType:'invoice.paid',payload:{id:eventId}});
    assert.strictEqual(duplicate,null,'Processed provider event was reacquired');

    const p=await plan('ordering'),c=await customer('ordering'),intent=await intents.createIntent({scope:'customer',customerId:c.id,planId:p.id,provider:'stripe',checkoutMode:'payment',commercialSnapshot:snapshot(p)}),providerCheckout=`cs_order_${suffix}`;
    await intents.attachProviderCheckout(intent.id,providerCheckout);
    await intents.completeVerifiedProvider('stripe',providerCheckout,'completed');
    const lateFailure=await intents.completeVerifiedProvider('stripe',providerCheckout,'failed');
    const lateCancel=await intents.completeVerifiedProvider('stripe',providerCheckout,'cancelled');
    assert.strictEqual(lateFailure.state,'completed','Late provider failure regressed a completed checkout');
    assert.strictEqual(lateCancel.state,'completed','Late provider cancellation regressed a completed checkout');
}

async function workerCrashRecovery() {
    const owner=(await customer('provider-op')).id,key=`op-race-${suffix}`;
    const first=await providerOps.begin({provider:'stripe',scope:'customer',ownerId:owner,operationType:'cancel_subscription',localReference:`sub_local_${suffix}`,idempotencyKey:key,request:{reason:'race smoke'}});
    await providerOps.providerApplied(first.id,{providerReference:`sub_remote_${suffix}`,result:{remote:'cancelled'}});
    await providerOps.recordError(first.id,new Error('simulated worker crash after provider success'),{terminal:true});
    const crashed=await providerOps.get(first.id);
    assert.strictEqual(crashed.state,'provider_applied','Crash bookkeeping lost provider-applied state');
    assert(/simulated worker crash/.test(crashed.last_error||''),'Crash bookkeeping lost recovery evidence');
    const retry=await providerOps.begin({provider:'stripe',scope:'customer',ownerId:owner,operationType:'cancel_subscription',localReference:`sub_local_${suffix}`,idempotencyKey:key,request:{reason:'race smoke'}});
    assert.strictEqual(String(retry.id),String(first.id),'Retry created a second provider operation instead of reusing idempotency key');
    const open=await providerOps.open({limit:500});
    assert(open.some(row=>String(row.id)===String(first.id)),'Provider-applied crash was not discoverable for reconciliation');
    await providerOps.localApplied(first.id,{result:{recovered:true}});
    await providerOps.reconciled(first.id,{result:{verified:true}});
    const final=await providerOps.get(first.id);
    assert.strictEqual(final.state,'reconciled','Recovered provider operation did not reach reconciled state');
}

async function main(){
    try{
        await ensureFleetServers();
        await lastDiscountUse();
        await freeClaimRace();
        await checkoutSurvivesCatalogueRetirement();
        await duplicateAndOutOfOrderProviderEvents();
        await workerCrashRecovery();
        console.log('Adversarial concurrency smoke test passed.');
    } finally {
        await getPool().end();
    }
}
main().catch(error=>{console.error(error);process.exit(1)});
