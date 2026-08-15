'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}
function rel(file) { return path.relative(ROOT, file).replaceAll(path.sep, '/'); }

const packageJson = JSON.parse(read('package.json'));
assert.strictEqual(packageJson.scripts.start, 'node src/application.js', 'supported startup must use canonical application composition');
assert.strictEqual(packageJson.scripts['automation:worker'], 'node scripts/automation-worker.js');
assert.strictEqual(packageJson.scripts.syntax, 'node scripts/check-js-syntax.js');

for (const removed of ['import_users.js', 'check-expired.js', 'src/platform/reseller-portal.js', 'src/platform/reseller-storefront.js']) {
    assert(!exists(removed), `${removed} must remain removed from the supported tree`);
}

for (const migration of [
    '016_reserved_legacy_gap.sql',
    '036_platform_coherence.sql',
    '037_activation_and_plan_transitions.sql',
    '038_commerce_and_security_policy.sql',
    '039_reseller_lifecycle_notifications.sql',
    '040_branding_assets.sql',
    '041_reseller_ledger_adjustments.sql',
    '042_jellyfin_policy_drift.sql',
    '043_reseller_dunning.sql',
    '044_recurring_trigger_fix.sql',
    '045_payment_incidents.sql',
    '046_restore_invitation_subscription_source.sql'
]) assert(exists(`db/migrations/${migration}`), `missing coherence migration ${migration}`);

const application = read('src/application.js');
assert(application.includes("require('./platform/admin-drift')"), 'Policy Drift must be mounted by the canonical application');
assert(application.includes("require('./platform/reseller-tier-changes')"), 'reseller tier changes must be mounted');
assert(!application.includes('reseller-portal'), 'canonical application must not load credit-first reseller portal');
assert(!application.includes('reseller-storefront'), 'canonical application must not load secondary storefront router');

const automation = read('src/automation/jobs.js');
for (const key of ['policy_drift', 'reseller_notifications', 'reseller_billing', 'reseller_estates', 'plan_changes']) {
    assert(new RegExp(`\\b${key}\\b`).test(automation), `automation worker is missing ${key}`);
}

const compose = read('docker-compose.yml');
assert(/automation-worker:[\s\S]*scripts\/automation-worker\.js/.test(compose), 'Compose must run the dedicated automation worker');
assert(!/captainfin_proxy/.test(compose), 'unused captainfin_proxy network must not return');

const readiness = read('scripts/production-readiness.js');
assert(!readiness.includes('JELLYFIN_ALLOWED_HOSTS'), 'readiness must not require the retired Jellyfin host allowlist');
for (const expected of ['provider-settings', 'request-service-settings', 'email-settings', 'plan-servers']) {
    assert(readiness.includes(expected), `readiness must use canonical ${expected} service`);
}

const runtimeSettings = read('src/platform/runtime-settings.js');
assert(!/process\.env\.SITE_NAME\s*=/.test(runtimeSettings), 'runtime settings must never mutate process.env.SITE_NAME');

const sourceFiles = walk(path.join(ROOT, 'src')).filter(file => file.endsWith('.js'));
for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert(!/process\.env\.SITE_NAME\s*=/.test(text), `${rel(file)} mutates SITE_NAME at runtime`);
    assert(!/db\/data\.json|db\\data\.json/.test(text), `${rel(file)} still depends on the JSON-era database`);
    assert(!/require\([^)]*reseller-portal/.test(text), `${rel(file)} still imports the removed reseller portal`);
    assert(!/require\([^)]*reseller-storefront/.test(text), `${rel(file)} still imports the removed reseller storefront`);
}

const branding = read('src/platform/branding.js');
assert(branding.includes('branding_assets'), 'branding must use shared PostgreSQL asset storage');
assert(branding.includes('importLegacy'), 'existing filesystem branding must have an upgrade-safe import path');

const plans = read('src/platform/admin-plans.js');
assert(plans.includes('Impact preview'), 'plan management must expose edit impact before destructive changes');
assert(plans.includes('impactConfirmation'), 'impactful plan changes must require explicit confirmation');
assert(!/Authenticator \/ recovery code/i.test(plans), 'plan management must not show fake repeated 2FA prompts');

const catalog = read('src/platform/admin-catalog-shell.js');
assert(!/Authenticator \/ recovery code/i.test(catalog), 'plan/customer creation must not show fake repeated 2FA prompts');
assert(catalog.includes('one-time activation link'), 'admin-created customers must choose their own password through activation');

const lifecycle = read('src/payments/lifecycle.js');
for (const policy of ['once_ever', 'once_per_plan', 'before_paid', 'renewable', 'permanent', 'downgradeToFree']) {
    assert(lifecycle.includes(policy), `free/trial policy is missing ${policy}`);
}

const directCheckout = read('src/platform/flexible-checkout.js');
assert(/idempotencyKey\s*:\s*intent\.id/.test(directCheckout), 'direct checkout must pass the durable local intent ID to payment providers');
const stripeBilling = read('src/payments/stripe.js');
assert(stripeBilling.includes('internal_checkout_intent_id'), 'Stripe checkout must preserve the local intent ID in provider metadata');
assert(/checkout\.sessions\.create\(params,\s*\{\s*idempotencyKey/.test(stripeBilling), 'Stripe checkout must use a provider idempotency key');
const paypalBilling = read('src/payments/paypal.js');
assert(/providerRequestId\s*=\s*idempotencyKey/.test(paypalBilling), 'PayPal checkout must derive PayPal-Request-Id from the local checkout intent');

const customerPlanChange = read('src/payments/customer-plan-change.js');
assert(!/effective_at<=NOW\(\)\+INTERVAL\s*'15 minutes'/.test(customerPlanChange), 'scheduled customer plan changes must not alter entitlements before the paid-through boundary');
assert(customerPlanChange.includes("effective_at<=NOW()"), 'scheduled Stripe plan changes must become due only at the paid-through boundary');
assert(customerPlanChange.includes('scheduledStripeSubscription'), 'due plan changes must resolve their recorded subscription even immediately after its previous period ends');

const resellerBilling = read('src/payments/reseller-billing-v2-core.js');
for (const fn of ['requestTierChange', 'cancelPendingTierChange', 'applyDueTierChanges', 'validateTierMapping']) {
    assert(resellerBilling.includes(fn), `reseller billing is missing ${fn}`);
}
assert(/idempotencyKey\s*:\s*intent\.id/.test(resellerBilling), 'reseller checkout must pass the durable local intent ID to its provider core');
const resellerBillingCore = read('src/payments/reseller-billing-core.js');
assert(resellerBillingCore.includes('internal_checkout_intent_id'), 'reseller Stripe checkout must preserve the local intent ID in provider metadata');
assert(resellerBillingCore.includes('reseller-checkout-'), 'reseller Stripe checkout must use a stable provider idempotency key');
assert(/requestId:\s*idempotencyKey\s*\?/.test(resellerBillingCore), 'reseller PayPal checkout must use the local intent ID as PayPal-Request-Id');

const drift = read('src/jellyfin/drift-control.js');
assert(drift.includes("method:'GET'") || drift.includes("method: 'GET'"), 'drift audit must explicitly use read-only Jellyfin GET');
assert(exists('scripts/jellyfin-drift-smoke.js'), 'current-schema Policy Drift smoke test must exist');

console.log(`platform coherence static contract: ok (${sourceFiles.length} source files inspected)`);
