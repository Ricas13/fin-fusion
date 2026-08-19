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

function sqlStatements(source) {
    const statements = [];
    const re = /\b(?:query|client\.query)\s*\(\s*([`'"])([\s\S]*?)\1/g;
    let match;
    while ((match = re.exec(source))) statements.push(match[2]);
    return statements;
}

// Provider billing identities and provider-driven subscription state must remain
// behind the lifecycle layer. lifecycle.js owns policy/orchestration; the
// primitives module owns low-level provider persistence/event leasing.
const PROVIDER_MUTATION_OWNERS = new Set([
    'src/payments/lifecycle-primitives.js',
    'src/payments/lifecycle.js',
    'src/payments/customer-plan-change.js'
]);

const ENTITLEMENT_CONSUMERS = [
    /^src\/jellyfin\/(?:activity|policy|provisioning|provisioning-core|placement|placement-preview|plan-servers)\.js$/,
    /^src\/integrations\/.+\.js$/
];

const RAW_READ_EXCEPTIONS = new Set(['src/jellyfin/activity.js']);

const failures = [];
const sourceFiles = filesUnder(SRC);
for (const file of sourceFiles) {
    const name = rel(file);
    const source = fs.readFileSync(file, 'utf8');
    const statements = sqlStatements(source);

    if (!PROVIDER_MUTATION_OWNERS.has(name)) {
        for (const sql of statements) {
            const mutatesSubscription = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+subscriptions\b/i.test(sql);
            const touchesProviderState = /\b(?:provider_subscription_id|provider_customer_id|provider_status|pending_provider_|source\s*=\s*['"](?:stripe|paypal)['"])/i.test(sql);
            if (mutatesSubscription && touchesProviderState) {
                failures.push(`${name}: provider-backed subscription mutation outside lifecycle owner`);
                break;
            }
        }
    }

    if (ENTITLEMENT_CONSUMERS.some(pattern => pattern.test(name)) && !RAW_READ_EXCEPTIONS.has(name)) {
        const rawRead = statements.some(sql => /\b(?:FROM|JOIN)\s+subscriptions\b/i.test(sql));
        const canonical = /effective_customer_entitlements|subscription-state/.test(source);
        if (rawRead && !canonical) failures.push(`${name}: raw subscription read in entitlement consumer`);
    }
}

// The historical lifecycle-core path must never become a second implementation
// again. Any direct importer receives the exact canonical lifecycle surface.
const lifecycleCore = fs.readFileSync(path.join(SRC, 'payments', 'lifecycle-core.js'), 'utf8');
const lifecycle = fs.readFileSync(path.join(SRC, 'payments', 'lifecycle.js'), 'utf8');
const primitives = fs.readFileSync(path.join(SRC, 'payments', 'lifecycle-primitives.js'), 'utf8');
if (!/module\.exports\s*=\s*require\(['"]\.\/lifecycle['"]\)/.test(lifecycleCore)) {
    failures.push('src/payments/lifecycle-core.js: historical path must delegate directly to lifecycle.js');
}
if (/\basync\s+function\b|\bfunction\s+(?:startFreeTrial|claimFreePlan|getProviderPlan)\b/.test(lifecycleCore)) {
    failures.push('src/payments/lifecycle-core.js: duplicate lifecycle implementation detected');
}
if (/require\(['"]\.\/lifecycle-core['"]\)/.test(lifecycle)) {
    failures.push('src/payments/lifecycle.js: canonical lifecycle must depend on primitives, not lifecycle-core');
}
if (!/require\(['"]\.\/lifecycle-primitives['"]\)/.test(lifecycle)) {
    failures.push('src/payments/lifecycle.js: canonical lifecycle must use lifecycle-primitives');
}
for (const highLevel of ['startFreeTrial', 'claimFreePlan', 'getProviderPlan', 'getProviderOptions', 'getProviderPlanByExternalId']) {
    if (new RegExp(`\\b(?:async\\s+)?function\\s+${highLevel}\\b`).test(primitives)) {
        failures.push(`src/payments/lifecycle-primitives.js: high-level policy ${highLevel} belongs in lifecycle.js`);
    }
}

// subscriptions.js is the stable compatibility service. Keep the historical
// subscriptions-core path as an alias so direct imports cannot create another
// independent manual/provider compatibility implementation.
const subscriptions = fs.readFileSync(path.join(SRC, 'subscriptions.js'), 'utf8');
const subscriptionsCore = fs.readFileSync(path.join(SRC, 'subscriptions-core.js'), 'utf8');
if (!/module\.exports\s*=\s*require\(['"]\.\/subscriptions['"]\)/.test(subscriptionsCore)) {
    failures.push('src/subscriptions-core.js: historical path must delegate directly to subscriptions.js');
}
if (/\basync\s+function\b|\bINSERT\s+INTO\s+subscriptions\b/i.test(subscriptionsCore)) {
    failures.push('src/subscriptions-core.js: duplicate subscriptions implementation detected');
}
for (const exported of ['getPlanByCode', 'createManualSubscription', 'applyProviderState']) {
    if (!new RegExp(`\\b(?:async\\s+)?function\\s+${exported}\\b`).test(subscriptions)) {
        failures.push(`src/subscriptions.js: canonical subscriptions service must own ${exported}`);
    }
}

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
console.log(`Lifecycle boundary static check passed (${sourceFiles.length} source files scanned).`);
