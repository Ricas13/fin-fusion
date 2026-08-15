'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function filesUnder(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...filesUnder(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function rel(file) { return path.relative(ROOT, file).split(path.sep).join('/'); }

// Provider billing identities and provider-driven subscription state must remain
// behind the lifecycle layer. These are the deliberately small modules that own
// those transitions. Adding another owner should require a conscious review of
// this list rather than silently spreading provider mutation SQL into routes.
const PROVIDER_MUTATION_OWNERS = new Set([
    'src/payments/lifecycle-core.js',
    'src/payments/lifecycle.js',
    'src/payments/customer-plan-change.js',
    'src/resellers/monthly.js'
]);

const ENTITLEMENT_CONSUMERS = [
    /^src\/jellyfin\/(?:activity|policy|provisioning|provisioning-core|placement|placement-preview|plan-servers)\.js$/,
    /^src\/integrations\/.+\.js$/
];

const failures = [];
for (const file of filesUnder(SRC)) {
    const name = rel(file);
    const source = fs.readFileSync(file, 'utf8');

    // Flag SQL that mutates provider-backed subscription rows outside the
    // lifecycle owners. This intentionally keys on both the table mutation and
    // provider identity/state markers to avoid blocking harmless reporting SQL.
    const mutatesSubscription = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:subscriptions|reseller_subscriptions)\b/i.test(source);
    const touchesProviderState = /\b(?:provider_subscription_id|provider_customer_id|provider_status|pending_provider_|source\s*=\s*['"](?:stripe|paypal)['"])/i.test(source);
    if (mutatesSubscription && touchesProviderState && !PROVIDER_MUTATION_OWNERS.has(name)) {
        failures.push(`${name}: provider-backed subscription mutation outside lifecycle owner`);
    }

    // Enforcement consumers must use the canonical entitlement view/service,
    // not reconstruct “active subscription” rules from raw subscriptions.
    if (ENTITLEMENT_CONSUMERS.some(pattern => pattern.test(name))) {
        const rawRead = /\b(?:FROM|JOIN)\s+subscriptions\b/i.test(source);
        const canonical = /effective_customer_entitlements|subscription-state/.test(source);
        if (rawRead && !canonical) failures.push(`${name}: raw subscription read in entitlement consumer`);
    }
}

// Migration history is keyed by full filename, so historical duplicate numeric
// prefixes cannot safely be renamed after deployment. Enforce monotonic unique
// numeric prefixes from migration 063 onward instead.
const migrationDir = path.join(ROOT, 'db', 'migrations');
const modern = fs.readdirSync(migrationDir)
    .map(name => ({ name, match: name.match(/^(\d{3})_/)}))
    .filter(x => x.match && Number(x.match[1]) >= 63);
const seen = new Map();
for (const item of modern) {
    const prefix = item.match[1];
    if (seen.has(prefix)) failures.push(`db/migrations/${item.name}: duplicates modern migration prefix ${prefix} already used by ${seen.get(prefix)}`);
    else seen.set(prefix, item.name);
}

if (failures.length) {
    console.error('Lifecycle boundary static check failed:');
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
}
console.log(`Lifecycle boundary static check passed (${filesUnder(SRC).length} source files scanned).`);
