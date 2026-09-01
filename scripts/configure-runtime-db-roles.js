'use strict';

require('dotenv').config();
const { getPool } = require('../src/db');

const ROLE_SPECS = {
    app: { role: 'steamfusion_app', urlEnv: 'APP_DATABASE_URL', connectionLimit: 40, statementTimeout: '30s', lockTimeout: '10s', idleTimeout: '30s', createdb: false },
    automation: { role: 'steamfusion_automation', urlEnv: 'AUTOMATION_DATABASE_URL', connectionLimit: 12, statementTimeout: '90s', lockTimeout: '10s', idleTimeout: '60s', createdb: false },
    activity: { role: 'steamfusion_activity', urlEnv: 'ACTIVITY_DATABASE_URL', connectionLimit: 5, statementTimeout: '15s', lockTimeout: '5s', idleTimeout: '15s', createdb: false },
    backup: { role: 'steamfusion_backup', urlEnv: 'BACKUP_DATABASE_URL', connectionLimit: 6, statementTimeout: '0', lockTimeout: '10s', idleTimeout: '60s', createdb: false },
    backupVerify: { role: 'steamfusion_backup_verify', urlEnv: 'BACKUP_VERIFY_DATABASE_URL', connectionLimit: 3, statementTimeout: '0', lockTimeout: '10s', idleTimeout: '60s', createdb: true }
};

const APP_DELETE_TABLES = Object.freeze([
    // Session/security rows have explicit lifecycle owners in the web process.
    'user_sessions','account_activation_tokens','account_tokens','auth_recovery_codes','auth_sessions','auth_totp_enrollments','login_rate_limits',
    'admin_channel_link_tokens','customer_channel_link_tokens','customer_account_claims','pending_registrations','free_access_registration_reservations',
    // Replaceable preference/configuration/mapping rows used by mounted admin/customer routes.
    'admin_nav_read_state','admin_notification_preferences','customer_notification_preferences','customer_library_overrides','customer_library_selection','customer_policy_overrides',
    'plan_server_eligibility','plan_stremio_sources','request_routes','stremio_source_libraries','stremio_sources','arr_instances',
    // Runtime caches/leases are not durable business history.
    'stremio_source_playback_leases','stremio_media_index','stremio_source_media_index','active_playback_sessions',
    // Jellyfin account removal is an explicit provisioning operation; customer rows themselves are finalized only through finalize_customer_deletion().
    'jellyfin_accounts'
]);

const APP_APPEND_ONLY_TABLES = Object.freeze([
    'auth_events','customer_download_events','discount_redemptions','invitation_redemptions','payment_incident_notes',
    'referral_reward_reversals','stream_policy_events','stremio_stream_attribution','subscription_service_extension_events'
]);

const APP_READ_ONLY_TABLES = Object.freeze([
    'schema_migrations','playback_history','operational_worker_state','activity_worker_state','jellyfin_activity_poll_state'
]);

function credentialFromUrl(envName, expectedRole, { optional = false } = {}) {
    const raw = String(process.env[envName] || '').trim();
    if (!raw) { if (optional) return null; throw new Error(`${envName} is required`); }
    let url;
    try { url = new URL(raw); } catch { throw new Error(`${envName} must be a valid PostgreSQL URL`); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${envName} must use postgres:// or postgresql://`);
    const username = decodeURIComponent(url.username || '');
    const password = decodeURIComponent(url.password || '');
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (username !== expectedRole) throw new Error(`${envName} must authenticate as ${expectedRole}`);
    if (!url.hostname || !database) throw new Error(`${envName} must include host and database`);
    if (password.length < 24) throw new Error(`${envName} password must be at least 24 characters`);
    return { envName, role: expectedRole, password, database, hostname: url.hostname };
}

function activityCredential({ optional = false } = {}) {
    const fromUrl = credentialFromUrl('ACTIVITY_DATABASE_URL', ROLE_SPECS.activity.role, { optional: true });
    if (fromUrl) return fromUrl;
    const password = String(process.env.ACTIVITY_DB_PASSWORD || '');
    if (!password) { if (optional) return null; throw new Error('ACTIVITY_DATABASE_URL (or legacy ACTIVITY_DB_PASSWORD) is required'); }
    if (password.length < 24) throw new Error('ACTIVITY_DB_PASSWORD must be at least 24 characters');
    return { envName: 'ACTIVITY_DB_PASSWORD', role: ROLE_SPECS.activity.role, password, database: null, hostname: null };
}

function ownerPassword() {
    const raw = String(process.env.DATABASE_URL || '').trim();
    if (!raw) throw new Error('DATABASE_URL is required to configure runtime database roles');
    try { return decodeURIComponent(new URL(raw).password || ''); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
}

function validateDistinctCredentials(credentials) {
    const owner = ownerPassword();
    const seen = new Map();
    for (const item of credentials) {
        if (!item) continue;
        if (owner && item.password === owner) throw new Error(`${item.envName} must not reuse the owner DATABASE_URL password`);
        if (seen.has(item.password)) throw new Error(`${item.envName} must not reuse the password from ${seen.get(item.password)}`);
        seen.set(item.password, item.envName);
    }
}

async function ensureRole(client, spec, credential) {
    const role = spec.role;
    await client.query(`DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $role$;`);
    await client.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER ${spec.createdb ? 'CREATEDB' : 'NOCREATEDB'} NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT ${spec.connectionLimit}`);
    await client.query("SELECT set_config('steamfusion.runtime_role_password',$1,false)", [credential.password]);
    await client.query(`DO $password$ BEGIN EXECUTE format('ALTER ROLE ${role} PASSWORD %L', current_setting('steamfusion.runtime_role_password')); END $password$;`);
    await client.query(`ALTER ROLE ${role} SET statement_timeout='${spec.statementTimeout}'`);
    await client.query(`ALTER ROLE ${role} SET lock_timeout='${spec.lockTimeout}'`);
    await client.query(`ALTER ROLE ${role} SET idle_in_transaction_session_timeout='${spec.idleTimeout}'`);
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
}

async function tableExists(client, table) {
    const result = await client.query('SELECT to_regclass($1) AS table_name', [`public.${table}`]);
    return Boolean(result.rows[0]?.table_name);
}

async function grantExistingTables(client, role, privileges, tables) {
    for (const table of tables) {
        if (await tableExists(client, table)) await client.query(`GRANT ${privileges} ON ${table} TO ${role}`);
    }
}

async function revokeExistingTables(client, role, privileges, tables) {
    for (const table of tables) {
        if (await tableExists(client, table)) await client.query(`REVOKE ${privileges} ON ${table} FROM ${role}`);
    }
}

async function grantDeletionFinalizer(client, role) {
    const exists = await client.query("SELECT to_regprocedure('public.finalize_customer_deletion(uuid)') AS function_name");
    if (exists.rows[0]?.function_name) await client.query(`GRANT EXECUTE ON FUNCTION public.finalize_customer_deletion(uuid) TO ${role}`);
}

async function grantRetentionFunctions(client, role) {
    const retention = await client.query("SELECT to_regprocedure('public.run_data_retention_batch(text,timestamptz,integer)') AS retention, to_regprocedure('public.cleanup_expired_access_network_leases(integer)') AS leases");
    if (retention.rows[0]?.retention) await client.query(`GRANT EXECUTE ON FUNCTION public.run_data_retention_batch(text,timestamptz,integer) TO ${role}`);
    if (retention.rows[0]?.leases) await client.query(`GRANT EXECUTE ON FUNCTION public.cleanup_expired_access_network_leases(integer) TO ${role}`);
}

async function revokeFutureRuntimeDefaults(client) {
    // Migrations run as the owner/deploy role. New tables/functions are deliberately inaccessible
    // until this script or the migration grants the exact runtime capability they require.
    for (const spec of Object.values(ROLE_SPECS)) {
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${spec.role}`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${spec.role}`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ${spec.role}`);
    }
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
}

async function grantApp(client) {
    const role = ROLE_SPECS.app.role;
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    // Existing mounted routes keep their current INSERT/UPDATE compatibility. DELETE is opt-in below.
    await client.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await grantExistingTables(client, role, 'DELETE', APP_DELETE_TABLES);
    await revokeExistingTables(client, role, 'UPDATE,DELETE', APP_APPEND_ONLY_TABLES);
    await revokeExistingTables(client, role, 'INSERT,UPDATE,DELETE', APP_READ_ONLY_TABLES);
    if (await tableExists(client, 'audit_log')) await client.query(`REVOKE UPDATE,DELETE ON audit_log FROM ${role}`);
    if (await tableExists(client, 'payment_events')) await client.query(`REVOKE DELETE ON payment_events FROM ${role}`);
    if (await tableExists(client, 'provider_operations')) await client.query(`REVOKE DELETE ON provider_operations FROM ${role}`);
    if (await tableExists(client, 'notification_outbox')) await client.query(`REVOKE DELETE ON notification_outbox FROM ${role}`);
    if (await tableExists(client, 'customers')) await client.query(`REVOKE DELETE ON customers FROM ${role}`);
    if (await tableExists(client, 'subscriptions')) await client.query(`REVOKE DELETE ON subscriptions FROM ${role}`);
    await grantDeletionFinalizer(client, role);
}

async function grantAutomation(client) {
    const role = ROLE_SPECS.automation.role;
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    if (await tableExists(client, 'audit_log')) await client.query(`REVOKE UPDATE,DELETE ON audit_log FROM ${role}`);
    for (const table of ['auth_totp_enrollments','auth_recovery_codes','auth_sessions','auth_events','login_rate_limits','schema_migrations','user_sessions']) {
        if (await tableExists(client, table)) await client.query(`REVOKE ALL ON ${table} FROM ${role}`);
    }
    if (await tableExists(client, 'app_users')) {
        await client.query(`REVOKE INSERT,UPDATE,DELETE ON app_users FROM ${role}`);
        await client.query(`GRANT SELECT ON app_users TO ${role}`);
    }
    // Financial and provider history is never a generic automation cleanup target.
    await revokeExistingTables(client, role, 'DELETE', [
        'affiliate_credit_ledger','affiliate_credit_renewal_reservations','payment_events','payment_incidents','payment_incident_notes','provider_operations',
        'subscriptions','subscription_service_extension_events','referral_reward_reversals','discount_redemptions','invitation_redemptions'
    ]);
    await grantDeletionFinalizer(client, role);
    await grantRetentionFunctions(client, role);
}

async function grantActivity(client) {
    const role = ROLE_SPECS.activity.role;
    const required = await client.query(`SELECT
        to_regclass('public.active_playback_sessions') AS active,
        to_regclass('public.playback_history') AS history,
        to_regclass('public.stream_policy_events') AS events,
        to_regclass('public.jellyfin_server_metrics') AS metrics,
        to_regclass('public.jellyfin_activity_poll_state') AS activity_poll_state,
        to_regclass('public.access_network_leases') AS network_leases,
        to_regclass('public.access_network_events') AS network_events,
        to_regclass('public.customer_lane_policy_overrides') AS lane_overrides,
        to_regclass('public.customer_entitlement_overrides') AS entitlement_overrides,
        to_regclass('public.media_account_device_policy') AS media_device_policy,
        to_regclass('public.media_account_devices') AS media_devices,
        to_regprocedure('public.record_activity_worker_heartbeat(text,text,text,boolean,jsonb)') AS heartbeat_function`);
    if (!required.rows[0].active || !required.rows[0].history || !required.rows[0].events || !required.rows[0].metrics || !required.rows[0].activity_poll_state || !required.rows[0].network_leases || !required.rows[0].network_events || !required.rows[0].lane_overrides || !required.rows[0].entitlement_overrides || !required.rows[0].media_device_policy || !required.rows[0].media_devices || !required.rows[0].heartbeat_function) {
        throw new Error('Run database migrations before configuring the activity role');
    }
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT(id,name,slug,server_class,media_server_type,base_url,public_url,enabled,priority,max_users,health_status,last_health_check,api_key_encrypted) ON jellyfin_servers TO ${role}`);
    await client.query(`GRANT SELECT(id,customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,last_activity_at,created_at) ON jellyfin_accounts TO ${role}`);
    await client.query(`GRANT UPDATE(last_activity_at,updated_at) ON jellyfin_accounts TO ${role}`);
    await client.query(`GRANT SELECT(id,customer_id,plan_id,status,source,provider_subscription_id,current_period_end,created_at,starts_at,superseded_by,service_extension_days,service_type_snapshot,commercial_snapshot) ON subscriptions TO ${role}`);
    await client.query(`GRANT SELECT(id,name,code,streams,active,service_type,is_free_tier,is_addon,kick_4k_transcodes,jellyfin_access_model,jellyfin_household_network_limit,jellyfin_household_lease_minutes) ON plans TO ${role}`);
    await client.query(`GRANT SELECT(id,access_paused_at) ON customers TO ${role}`);
    await client.query(`GRANT SELECT(customer_id,access_lane,streams) ON customer_lane_policy_overrides TO ${role}`);
    await client.query(`GRANT SELECT(customer_id,subscription_id,permanent_access,revoked_at) ON customer_entitlement_overrides TO ${role}`);
    await client.query(`GRANT SELECT(setting_key,setting_value) ON platform_settings TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON active_playback_sessions TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON playback_history TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON stream_policy_events TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON jellyfin_server_metrics TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON jellyfin_activity_poll_state TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON access_network_leases TO ${role}`);
    await client.query(`GRANT SELECT,INSERT ON access_network_events TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON media_account_device_policy TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON media_account_devices TO ${role}`);
    await client.query(`GRANT USAGE,SELECT ON SEQUENCE playback_history_id_seq TO ${role}`);
    await client.query(`GRANT USAGE,SELECT ON SEQUENCE stream_policy_events_id_seq TO ${role}`);
    await client.query(`GRANT USAGE,SELECT ON SEQUENCE access_network_leases_id_seq TO ${role}`);
    await client.query(`GRANT USAGE,SELECT ON SEQUENCE access_network_events_id_seq TO ${role}`);
    await client.query(`GRANT EXECUTE ON FUNCTION public.record_activity_worker_heartbeat(text,text,text,boolean,jsonb) TO ${role}`);
}

async function grantBackup(client) {
    const role = ROLE_SPECS.backup.role;
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    for (const table of ['backup_runs','backup_worker_state','backup_verification_requests']) {
        if (await tableExists(client, table)) await client.query(`GRANT INSERT,UPDATE ON ${table} TO ${role}`);
    }
}

async function grantBackupVerify(client) {
    const role = ROLE_SPECS.backupVerify.role;
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
}

async function configureRoles({ activityOnly = false } = {}) {
    const credentials = activityOnly
        ? [{ key: 'activity', credential: activityCredential() }]
        : [
            { key: 'app', credential: credentialFromUrl(ROLE_SPECS.app.urlEnv, ROLE_SPECS.app.role) },
            { key: 'automation', credential: credentialFromUrl(ROLE_SPECS.automation.urlEnv, ROLE_SPECS.automation.role) },
            { key: 'activity', credential: activityCredential() },
            { key: 'backup', credential: credentialFromUrl(ROLE_SPECS.backup.urlEnv, ROLE_SPECS.backup.role) },
            { key: 'backupVerify', credential: credentialFromUrl(ROLE_SPECS.backupVerify.urlEnv, ROLE_SPECS.backupVerify.role) }
        ];
    validateDistinctCredentials(credentials.map(item => item.credential));
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const item of credentials) await ensureRole(client, ROLE_SPECS[item.key], item.credential);
        if (activityOnly) await grantActivity(client);
        else {
            await grantApp(client);
            await grantAutomation(client);
            await grantActivity(client);
            await grantBackup(client);
            await grantBackupVerify(client);
            await revokeFutureRuntimeDefaults(client);
        }
        await client.query('COMMIT');
        console.log(activityOnly ? 'Configured steamfusion_activity with least-privilege grants' : 'Configured isolated app, automation, activity, backup and backup-verify PostgreSQL roles');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

async function main(options = {}) { return configureRoles(options); }
if (require.main === module) {
    main({ activityOnly: process.argv.includes('--activity-only') }).catch(error => { console.error(error.message); process.exit(1); });
}
module.exports = { ROLE_SPECS, APP_DELETE_TABLES, APP_APPEND_ONLY_TABLES, APP_READ_ONLY_TABLES, credentialFromUrl, activityCredential, validateDistinctCredentials, configureRoles, main };