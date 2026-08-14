'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, getPool } = require('../src/db');

const ROOT = path.resolve(__dirname, '..');
const results = [];

function record(level, code, message) {
    results.push({ level, code, message });
}

function present(name) {
    return Boolean(String(process.env[name] || '').trim());
}

function secretLooksStrong(name) {
    const value = String(process.env[name] || '');
    return value.length >= 32 && !/change[-_ ]?(me|this)|example|placeholder|your[-_]/i.test(value);
}

function checkEnvironment() {
    if (!present('DATABASE_URL')) record('critical', 'database.missing', 'DATABASE_URL is not configured.');
    if (!secretLooksStrong('SESSION_SECRET')) record('critical', 'session.weak', 'SESSION_SECRET is missing, too short, or looks like a placeholder.');

    for (const key of ['DATA_ENCRYPTION_KEY', 'JELLYFIN_ENCRYPTION_KEY', 'AUTH_ENCRYPTION_KEY', 'BACKUP_ENCRYPTION_KEY']) {
        if (!secretLooksStrong(key)) record('critical', `secret.${key.toLowerCase()}`, `${key} is missing, too short, or looks like a placeholder.`);
    }

    const encryptionValues = ['DATA_ENCRYPTION_KEY', 'JELLYFIN_ENCRYPTION_KEY', 'AUTH_ENCRYPTION_KEY', 'BACKUP_ENCRYPTION_KEY']
        .map(name => String(process.env[name] || ''))
        .filter(Boolean);
    if (new Set(encryptionValues).size !== encryptionValues.length) {
        record('critical', 'secret.reuse', 'Purpose-specific encryption keys, including the backup key, must not reuse the same value.');
    }

    if (present('STRIPE_RESTRICTED_KEY') || present('STRIPE_API_KEY')) {
        if (!present('STRIPE_WEBHOOK_SECRET')) record('critical', 'stripe.webhook', 'Stripe is enabled but STRIPE_WEBHOOK_SECRET is not configured.');
    }

    if (present('PAYPAL_CLIENT_ID') || present('PAYPAL_CLIENT_SECRET')) {
        if (!(present('PAYPAL_CLIENT_ID') && present('PAYPAL_CLIENT_SECRET'))) {
            record('critical', 'paypal.credentials', 'PayPal configuration is incomplete.');
        }
        if (!present('PAYPAL_WEBHOOK_ID')) record('critical', 'paypal.webhook', 'PayPal is enabled but PAYPAL_WEBHOOK_ID is not configured.');
    }

    if (present('TMDB_READ_ACCESS_TOKEN') && !present('ARR_ALLOWED_HOSTS')) {
        record('warning', 'media.arr_allowlist', 'TMDB discovery is configured but ARR_ALLOWED_HOSTS is empty. Arr integrations should fail closed until hosts are allowlisted.');
    }

    if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
        record('warning', 'node_env', 'NODE_ENV is not set to production.');
    }
}

function migrationFiles() {
    const dir = path.join(ROOT, 'db', 'migrations');
    return fs.readdirSync(dir).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
}

async function checkDatabase() {
    if (!present('DATABASE_URL')) return;

    const migrations = migrationFiles();
    const applied = await query('SELECT filename, checksum FROM schema_migrations ORDER BY filename');
    const appliedNames = new Set(applied.rows.map(row => row.filename));
    const missing = migrations.filter(name => !appliedNames.has(name));
    if (missing.length) record('critical', 'migrations.pending', `Pending database migrations: ${missing.join(', ')}`);

    const users = await query(`
        SELECT
            COUNT(*) FILTER (WHERE role='admin' AND active=TRUE) AS active_admins,
            COUNT(*) FILTER (WHERE role='admin' AND active=TRUE AND totp_enabled=TRUE) AS admins_with_2fa
        FROM app_users
    `);
    if (Number(users.rows[0]?.active_admins || 0) < 1) record('critical', 'admin.none', 'No active administrator account exists.');
    if (Number(users.rows[0]?.active_admins || 0) > 0 && Number(users.rows[0]?.admins_with_2fa || 0) < 1) {
        record('warning', 'admin.2fa', 'No active administrator currently has two-factor authentication enabled.');
    }

    const servers = await query(`
        SELECT
            COUNT(*) FILTER (WHERE enabled=TRUE) AS enabled,
            COUNT(*) FILTER (WHERE enabled=TRUE AND (api_key_encrypted IS NULL OR api_key_encrypted='')) AS missing_keys,
            COUNT(*) FILTER (WHERE enabled=TRUE AND public_url IS NOT NULL AND public_url !~ '^https://') AS insecure_public_urls
        FROM jellyfin_servers
    `);
    if (Number(servers.rows[0]?.enabled || 0) < 1) record('critical', 'jellyfin.none', 'No enabled Jellyfin server is configured.');
    if (Number(servers.rows[0]?.missing_keys || 0) > 0) record('critical', 'jellyfin.keys', 'One or more enabled Jellyfin servers have no encrypted API key.');
    if (Number(servers.rows[0]?.insecure_public_urls || 0) > 0) record('critical', 'jellyfin.https', 'One or more enabled Jellyfin public URLs are not HTTPS.');

    const plans = await query(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE active=TRUE AND visible=TRUE AND audience IN ('direct','both')) AS public_total
        FROM plans
    `);
    if (Number(plans.rows[0]?.total || 0) < 1) record('critical', 'plans.none', 'No plans are configured.');
    if (Number(plans.rows[0]?.public_total || 0) < 1) record('warning', 'plans.public_none', 'No active visible direct-customer plan is available.');

    const stale = await query(`
        SELECT COUNT(*) AS count
        FROM subscriptions
        WHERE status IN ('active','trialing') AND current_period_end < NOW()
    `);
    if (Number(stale.rows[0]?.count || 0) > 0) record('critical', 'subscriptions.stale', 'Expired subscriptions are still marked active or trialing; run entitlement reconciliation before production.');

    const paymentErrors = await query(`
        SELECT COUNT(*) AS count
        FROM payment_events
        WHERE processed_at IS NULL AND processing_error IS NOT NULL
    `);
    if (Number(paymentErrors.rows[0]?.count || 0) > 0) record('warning', 'payments.failed_events', 'Unprocessed payment webhook events with errors require review.');

    const requestFailures = await query(`
        SELECT COUNT(*) AS count
        FROM content_requests
        WHERE status='failed' AND created_at > NOW() - INTERVAL '7 days'
    `);
    if (Number(requestFailures.rows[0]?.count || 0) > 0) record('warning', 'requests.failed_recently', 'Media requests have failed within the last seven days.');
}

async function main() {
    checkEnvironment();
    try {
        await checkDatabase();
    } catch (error) {
        record('critical', 'database.audit_failed', `Database readiness audit failed: ${error.message}`);
    }

    const critical = results.filter(item => item.level === 'critical');
    const warnings = results.filter(item => item.level === 'warning');
    const output = {
        ready: critical.length === 0,
        criticalCount: critical.length,
        warningCount: warnings.length,
        checks: results
    };

    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(output, null, 2));
    } else {
        console.log(`CAPTAiNFiN production readiness: ${output.ready ? 'READY' : 'NOT READY'}`);
        for (const item of results) console.log(`[${item.level.toUpperCase()}] ${item.code}: ${item.message}`);
        if (!results.length) console.log('No readiness issues detected.');
    }

    if (!output.ready) process.exitCode = 1;
}

main()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
