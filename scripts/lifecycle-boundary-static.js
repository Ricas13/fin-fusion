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

const PROVIDER_MUTATION_OWNERS = new Set([
    'src/payments/lifecycle-primitives.js',
    'src/payments/lifecycle.js',
    'src/payments/customer-plan-change.js'
]);

const MANUAL_SUBSCRIPTION_OWNER = 'src/entitlements/manual-subscriptions.js';

const ENTITLEMENT_CONSUMERS = [
    /^src\/jellyfin\/(?:activity|policy|provisioning|provisioning-engine|placement|placement-preview|plan-servers)\.js$/,
    /^src\/integrations\/.+\.js$/
];

const RAW_READ_EXCEPTIONS = new Set(['src/jellyfin/activity.js']);

const failures = [];
const sourceFiles = filesUnder(SRC);
let manualOwnerHasInsert = false;
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

    const insertsSubscription = statements.some(sql => /\bINSERT\s+INTO\s+subscriptions\b/i.test(sql));
    if (name === MANUAL_SUBSCRIPTION_OWNER) manualOwnerHasInsert = insertsSubscription;
    if (name === 'src/subscriptions.js' && insertsSubscription) {
        failures.push(`${name}: manual subscription INSERT must delegate to ${MANUAL_SUBSCRIPTION_OWNER}`);
    }

    if (ENTITLEMENT_CONSUMERS.some(pattern => pattern.test(name)) && !RAW_READ_EXCEPTIONS.has(name)) {
        const rawRead = statements.some(sql => /\b(?:FROM|JOIN)\s+subscriptions\b/i.test(sql));
        const canonical = /effective_customer_entitlements|subscription-state/.test(source);
        if (rawRead && !canonical) failures.push(`${name}: raw subscription read in entitlement consumer`);
    }
}

if (!manualOwnerHasInsert) failures.push(`${MANUAL_SUBSCRIPTION_OWNER}: canonical manual subscription INSERT is missing`);

const lifecycleCorePath = path.join(SRC, 'payments', 'lifecycle-core.js');
const lifecycle = fs.readFileSync(path.join(SRC, 'payments', 'lifecycle.js'), 'utf8');
const primitives = fs.readFileSync(path.join(SRC, 'payments', 'lifecycle-primitives.js'), 'utf8');
if (fs.existsSync(lifecycleCorePath)) {
    failures.push('src/payments/lifecycle-core.js: retired historical lifecycle facade must stay removed');
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

const subscriptions = fs.readFileSync(path.join(SRC, 'subscriptions.js'), 'utf8');
const subscriptionsCorePath = path.join(SRC, 'subscriptions-core.js');
if (fs.existsSync(subscriptionsCorePath)) {
    failures.push('src/subscriptions-core.js: retired historical subscriptions facade must stay removed');
}
for (const exported of ['getPlanByCode', 'createManualSubscription', 'applyProviderState']) {
    if (!new RegExp(`\\b(?:async\\s+)?function\\s+${exported}\\b`).test(subscriptions)) {
        failures.push(`src/subscriptions.js: canonical subscriptions service must own ${exported}`);
    }
}
if (!subscriptions.includes("require('./entitlements/manual-subscriptions')")) {
    failures.push('src/subscriptions.js: manual subscription creation must delegate to entitlement owner');
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
