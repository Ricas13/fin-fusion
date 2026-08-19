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

// Extract SQL text passed directly to query()/client.query(). The earlier
// checker combined unrelated SQL statements from the same source file, which
// could falsely flag a safe manual UPDATE merely because another SELECT in the
// file mentioned provider_subscription_id. Lifecycle ownership is a statement
// invariant, so inspect each SQL statement independently.
function sqlStatements(source) {
    const statements = [];
    const re = /\b(?:query|client\.query)\s*\(\s*([`'"])([\s\S]*?)\1/g;
    let match;
    while ((match = re.exec(source))) statements.push(match[2]);
    return statements;
}

// Provider billing identities and provider-driven subscription state must remain
// behind the lifecycle layer. Route and UI modules remain outside this list.
const PROVIDER_MUTATION_OWNERS = new Set([
    'src/payments/lifecycle-core.js',
    'src/payments/lifecycle.js',
    'src/payments/customer-plan-change.js'
]);

const MANUAL_SUBSCRIPTION_OWNER = 'src/entitlements/manual-subscriptions.js';
const MANUAL_COMPATIBILITY_CALLERS = new Set([
    'src/subscriptions-core.js',
    'src/entitlements/admin-grants.js'
]);

const ENTITLEMENT_CONSUMERS = [
    /^src\/jellyfin\/(?:activity|policy|provisioning|provisioning-core|placement|placement-preview|plan-servers)\.js$/,
    /^src\/integrations\/.+\.js$/
];

// Activity takes a read-only batch snapshot to attach a stream-limit number to
// observed Jellyfin sessions. It does not grant/provision access or mutate the
// subscription lifecycle; destructive enforcement still revalidates live
// sessions immediately before action. Keep this exception narrow and explicit.
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
    if (MANUAL_COMPATIBILITY_CALLERS.has(name) && insertsSubscription) {
        failures.push(`${name}: manual subscription INSERT must delegate to ${MANUAL_SUBSCRIPTION_OWNER}`);
    }

    // Enforcement consumers must use the canonical entitlement view/service,
    // not reconstruct “active subscription” rules from raw subscriptions.
    if (ENTITLEMENT_CONSUMERS.some(pattern => pattern.test(name)) && !RAW_READ_EXCEPTIONS.has(name)) {
        const rawRead = statements.some(sql => /\b(?:FROM|JOIN)\s+subscriptions\b/i.test(sql));
        const canonical = /effective_customer_entitlements|subscription-state/.test(source);
        if (rawRead && !canonical) failures.push(`${name}: raw subscription read in entitlement consumer`);
    }
}

if (!manualOwnerHasInsert) {
    failures.push(`${MANUAL_SUBSCRIPTION_OWNER}: canonical manual subscription INSERT is missing`);
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
console.log(`Lifecycle boundary static check passed (${sourceFiles.length} source files scanned).`);
