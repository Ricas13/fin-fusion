'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
for(const file of ['db/migrations/000_database_baseline.sql'])assert(fs.existsSync(path.join(root,file)),`${file} must exist`);
const customer=read('src/payments/customer-plan-change.js'),provisioning=read('src/jellyfin/provisioning.js'),provisioningHelpers=read('src/jellyfin/provisioning-helpers.js'),entitlement=read('src/entitlements/subscription-state.js'),canonical=read('db/migrations/000_database_baseline.sql'),app=read('src/application.js'),health=read('src/platform/health.js'),compose=read('docker-compose.yml');
assert(/operationType:'plan_change_schedule'/.test(customer)&&/providerOps\.begin/.test(customer),'customer Stripe period-end change must be represented by an idempotent provider operation');
assert(/subscriptionSchedules\.create/.test(customer)&&/from_subscription:current\.provider_subscription_id/.test(customer),'customer Stripe period-end change must create a provider subscription schedule from the current subscription');
assert(/subscriptionSchedules\.update/.test(customer)&&/phases:\[/.test(customer),'customer Stripe schedule must define provider phases before renewal');
assert(/idempotencyKey/.test(customer),'customer Stripe schedule mutations must carry provider idempotency keys');
assert(/subscriptionSchedules\.release\(schedule\.id\)/.test(customer),'cancelling a customer Stripe change must release the provider schedule');
assert(/providerOps\.providerApplied/.test(customer)&&/providerOps\.reconciled/.test(customer),'customer provider scheduling must record provider and local reconciliation states');
assert(/PayPal cannot replace an active billing agreement in place/.test(customer),'PayPal plan selection must not silently cancel an active agreement');
const jobs=read('src/automation/jobs.js'),notificationDispatch=read('src/integrations/notification-dispatch.js'),migrationExpiry=read('db/migrations/102_paypal_plan_change_checkout_expiry.sql'),migrationOpen=read('db/migrations/103_plan_change_open_state.sql'),resolution=read('src/payments/plan-change-resolution.js');
assert(/async function expireDuePaypal\(\)/.test(customer)&&/state='awaiting_checkout'/.test(customer),'PayPal plan changes past their effective date must transition out of pending instead of sitting inert forever');
assert(/notificationDispatch\.dispatch\(\{eventType:'subscription\.plan_change\.requires_checkout'/.test(customer),'a PayPal plan change reaching its effective date must notify the customer they need to check out again');
assert(/customerPlanChange\.expireDuePaypal\(\)/.test(jobs),'the plan_changes automation job must also process due PayPal plan changes, not just Stripe');
assert(/'subscription\.plan_change\.requires_checkout'/.test(notificationDispatch),'the PayPal checkout-required reminder must always email the customer, not depend on opt-in preferences alone');
assert(/awaiting_checkout/.test(migrationExpiry)&&/subscription\.plan_change\.requires_checkout/.test(migrationExpiry),'a migration must extend the plan-change state machine and seed the reminder notification preference');
assert(/state IN \('pending','awaiting_checkout'\)/.test(customer),'open plan-change queries must include awaiting_checkout');
assert(/customer_plan_changes_one_open/.test(migrationOpen)&&/WHERE state IN \('pending','awaiting_checkout'\)/.test(migrationOpen),'database uniqueness must allow only one open plan change across pending and awaiting_checkout states');
assert(/state='applied'/.test(resolution)&&/target_plan_id=\$2/.test(resolution)&&/state='awaiting_checkout'/.test(resolution),'a successful matching checkout must resolve an awaiting PayPal plan change to applied');
assert(/previousState:pending\.state/.test(customer),'cancelling an open plan change must audit whether it was pending or awaiting checkout');
assert(!/processed:Number\(stripe\.succeeded\|\|0\)\+Number\(stripe\.pending\|\|0\)/.test(jobs),'Stripe provider-waiting plan changes must not be counted as completed processed work');
assert(/waiting:Number\(stripe\.pending\|\|0\)/.test(jobs),'Stripe plan changes still waiting at the provider must be reported separately');

const paypal=read('src/payments/paypal.js'),stripe=read('src/payments/stripe.js'),plisio=read('src/payments/plisio.js'),lifecycle=read('src/payments/lifecycle-primitives.js'),paymentRetry=read('src/payments/payment-event-retry.js'),returns=read('src/platform/customer-payment-return.js'),checkout=read('src/platform/flexible-checkout.js'),subscriptions=read('src/subscriptions.js');
assert(/case 'BILLING\.SUBSCRIPTION\.ACTIVATED':await activateSubscription/.test(paypal),'PayPal activation events must use the first-purchase activation path');
assert(/case 'BILLING\.SUBSCRIPTION\.UPDATED':await syncSubscription/.test(paypal),'PayPal subscription updates must sync existing provider state instead of replaying purchase activation');
assert(/case 'PAYMENT\.SALE\.COMPLETED'[\s\S]*await syncCurrentSubscription\(subscriptionId\)/.test(paypal),'PayPal renewal sales must read current provider subscription state instead of replaying purchase activation');
assert(/if\(intent&&activateMissing\)\{const activated=await activateSubscription\(subscription\.id\)/.test(paypal),'an out-of-order first positive PayPal update may activate only when a matching local checkout intent exists and the caller permits missing activation');
assert(/activateMissing:false/.test(paypal),'negative PayPal events must be able to reconcile current provider state without creating missing access');
assert(/resolveRecordedPlanChange/.test(paypal)&&/resolveAwaitingCheckout/.test(resolution),'fresh PayPal checkout completion must resolve its recorded awaiting plan change');
for(const [name,source] of [['Stripe',stripe],['PayPal',paypal],['Plisio',plisio]])assert(/retryPaymentEvent/.test(source)&&/processing deferred to internal retry/.test(source),`${name} must retain verified processing failures for internal retry instead of throwing them back to the provider`);
assert(/claimRetryablePaymentEvents/.test(lifecycle)&&/FOR UPDATE SKIP LOCKED/.test(lifecycle),'payment-event retries must claim durable failed rows without duplicate workers');
assert(/async payment_events\(\)/.test(jobs)&&/paymentEventRetry\.run/.test(jobs),'automation must retry accepted payment events internally');
assert(/const PROVIDERS = \{ stripe, paypal, plisio \}/.test(paymentRetry),'internal payment-event retry must cover every supported payment gateway');
assert(/return null;\r?\n\}/.test(lifecycle.match(/function mapProviderStatus[\s\S]*?\r?\n\}/)?.[0]||''),'unknown provider statuses must not default to past_due');
assert(/status=COALESCE\(\$1,status\)/.test(lifecycle),'unknown provider updates must preserve the last known local subscription status');
const plisioWebhook=plisio.match(/async function processWebhook[\s\S]*?\n\}/)?.[0]||'';
assert(plisioWebhook&&plisioWebhook.indexOf('beginPaymentEvent')>=0&&plisioWebhook.indexOf('processClaimedCallback')>plisioWebhook.indexOf('beginPaymentEvent'),'Plisio must durably accept an authenticated callback before remote provider processing');
assert(!returns.includes('Your access details are below.'),'payment returns must not claim service delivery is ready immediately after commercial confirmation');
assert(returns.includes('Each service will show as ready as soon as setup finishes.'),'payment confirmation copy must distinguish payment success from delivery readiness');
assert(!returns.includes('function sameOrigin(){return false}'),'dead hardcoded sameOrigin helper must stay removed');
assert(/publicError\.present/.test(returns)&&!/encodeURIComponent\(error\.message\)/.test(returns),'payment return routes must preserve the public-error sanitizer');
assert(/publicError\.present/.test(checkout)&&/CHECKOUT_SAFE/.test(checkout)&&!/encodeURIComponent\(error\.message\)/.test(checkout),'checkout routes must preserve the #375 public-error sanitizer and local safe-message allowlist');
const legacyProviderState=subscriptions.match(/async function applyProviderState[\s\S]*?\n\}/)?.[0]||'';
assert(legacyProviderState&&!/beginPaymentEvent/.test(legacyProviderState),'legacy applyProviderState must not open a second payment_events lease');
assert(/updateProviderSubscription/.test(legacyProviderState),'legacy applyProviderState must delegate provider state to the canonical lifecycle');

assert(/return subscriptionState\.effectiveSubscription\(customerId\)/.test(provisioningHelpers),'provisioning helpers must use canonical entitlement resolution');
assert(/require\('\.\/provisioning-helpers'\)/.test(provisioning)&&/\.\.\.helpers/.test(provisioning),'legacy provisioning facade must delegate entitlement helpers instead of reimplementing them');
const effectiveSubscriptionSource=entitlement.match(/async function effectiveSubscription[\s\S]*?\n\}/)?.[0]||'';
assert(/IN \('jellyfin','bundle'\)/.test(effectiveSubscriptionSource),'application Jellyfin entitlement resolution must be explicitly service-scoped');
assert(!/FROM effective_customer_entitlements\b/.test(effectiveSubscriptionSource),'Jellyfin entitlement resolution must not consume the cross-service one-row view');
assert(/CREATE VIEW public\.effective_customer_entitlements/.test(canonical),'canonical entitlement view must be defined in migrations');
assert(/s\.starts_at\s*<=\s*now\(\)/.test(canonical),'canonical entitlement view must respect starts_at');
assert(!/p\.active\b/.test(canonical.match(/CREATE VIEW public\.effective_customer_entitlements[\s\S]*?ORDER BY[\s\S]*?s\.created_at DESC;/)?.[0]||''),'existing entitlement resolution must not depend on current catalogue active flag');
assert(/service_extension_days/.test(canonical)&&/customer_access_holds/.test(canonical),'canonical entitlement view must include extensions and typed holds');
assert(/createHealthRouter/.test(app)&&/Content-Security-Policy/.test(app)&&/\/health\/ready/.test(health),'assembled app must mount the readiness router and CSP');
assert(/healthcheck:[\s\S]*\/health\/ready/.test(compose),'web container must have a readiness healthcheck');

async function subscriptionOwnershipBehavior(){
  const stub=(request,exports)=>{const filename=require.resolve(request);require.cache[filename]={id:filename,filename,loaded:true,exports};};
  const existing={id:'subscription-row',customer_id:'customer-a',plan_id:'plan-a',source:'plisio',provider_subscription_id:'invoice-1'};
  let calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql==='SELECT id FROM customers WHERE id=$1 FOR UPDATE')return{rowCount:1,rows:[{id:params[0]}]};
    if(sql==='SELECT * FROM plans WHERE id=$1')return{rowCount:1,rows:[{id:'plan-a',name:'Plan A',code:'plan-a',billing_interval:'month',duration_days:30,price_minor:600,currency:'GBP'}]};
    if(sql.startsWith('SELECT external_id FROM plan_provider_prices'))return{rowCount:0,rows:[]};
    if(sql.startsWith('SELECT * FROM subscriptions WHERE source='))return{rowCount:1,rows:[existing]};
    if(sql.startsWith('UPDATE subscriptions SET'))return{rowCount:1,rows:[{...existing,status:'active'}]};
    if(sql.startsWith('INSERT INTO audit_log'))return{rowCount:1,rows:[]};
    throw new Error(`Unexpected lifecycle ownership SQL: ${sql}`);
  }};
  stub('../src/db',{query:async()=>({rowCount:0,rows:[]}),transaction:async work=>work(client)});
  stub('../src/jellyfin/resilient-provisioning',{reconcileCustomer:async()=>null});
  stub('../src/entitlements/access-holds',{addHold:async()=>null,releaseHold:async()=>null});
  stub('../src/payments/discounts',{redeemForSubscriptionTx:async()=>null});
  stub('../src/referrals',{rewardIfQualifying:async()=>null});
  delete require.cache[require.resolve('../src/payments/lifecycle-primitives')];
  const primitives=require('../src/payments/lifecycle-primitives');
  const activate=customerId=>primitives.activatePurchase({customerId,planId:'plan-a',provider:'plisio',providerSubscriptionId:'invoice-1',providerStatus:'completed'});

  await assert.rejects(activate('customer-b'),error=>error?.code==='PROVIDER_SUBSCRIPTION_CUSTOMER_MISMATCH','activatePurchase must reject a provider subscription already owned by another customer');
  assert(!calls.some(call=>call.sql.startsWith('UPDATE subscriptions SET')),'cross-customer activation must fail before updating the subscription');

  calls=[];
  const row=await activate('customer-a');
  const update=calls.find(call=>call.sql.startsWith('UPDATE subscriptions SET'));
  assert(update,'same-customer activation must still refresh the subscription');
  assert(!/SET\s+customer_id\s*=/.test(update.sql),'existing provider subscriptions must never update customer_id');
  assert.strictEqual(row.customer_id,'customer-a','same-customer activation must preserve subscription ownership');
}

subscriptionOwnershipBehavior().then(()=>console.log('provider scheduling and lifecycle contract OK')).catch(error=>{console.error(error);process.exitCode=1;});
