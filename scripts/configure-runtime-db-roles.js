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

async function grantDeletionFinalizer(client, role) {
    const exists = await client.query("SELECT to_regprocedure('public.finalize_customer_deletion(uuid)') AS function_name");
    if (exists.rows[0]?.function_name) {
        await client.query(`GRANT EXECUTE ON FUNCTION public.finalize_customer_deletion(uuid) TO ${role}`);
    }
}

async function grantApp(client) {
    const role = ROLE_SPECS.app.role;
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`REVOKE INSERT,UPDATE,DELETE ON schema_migrations FROM ${role}`);
    await client.query(`GRANT SELECT ON schema_migrations TO ${role}`);
    await client.query(`REVOKE UPDATE,DELETE ON audit_log FROM ${role}`);
    await grantDeletionFinalizer(client, role);
}

async function grantAutomation(client) {
    const role = ROLE_SPECS.automation.role;
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`REVOKE UPDATE,DELETE ON audit_log FROM ${role}`);
    for (const table of ['auth_totp_enrollments','auth_recovery_codes','auth_sessions','auth_events','login_rate_limits','schema_migrations','user_sessions']) {
        const exists = await client.query('SELECT to_regclass($1) AS table_name', [`public.${table}`]);
        if (exists.rows[0]?.table_name) await client.query(`REVOKE ALL ON ${table} FROM ${role}`);
    }
    const appUsers = await client.query("SELECT to_regclass('public.app_users') AS table_name");
    if (appUsers.rows[0]?.table_name) {
        await client.query(`REVOKE INSERT,UPDATE,DELETE ON app_users FROM ${role}`);
        await client.query(`GRANT SELECT ON app_users TO ${role}`);
    }
    await grantDeletionFinalizer(client, role);
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
        to_regprocedure('public.record_activity_worker_heartbeat(text,text,text,boolean,jsonb)') AS heartbeat_function`);
    if (!required.rows[0].active || !required.rows[0].history || !required.rows[0].events || !required.rows[0].metrics || !required.rows[0].activity_poll_state || !required.rows[0].network_leases || !required.rows[0].network_events || !required.rows[0].lane_overrides || !required.rows[0].entitlement_overrides || !required.rows[0].heartbeat_function) {
        throw new Error('Run database migrations before configuring the activity role');
    }
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT(id,name,slug,server_class,base_url,public_url,enabled,priority,max_users,health_status,last_health_check,api_key_encrypted) ON jellyfin_servers TO ${role}`);
    await client.query(`GRANT SELECT(id,customer_id,server_id,jellyfin_user_id,disabled,account_purpose,access_lane,last_activity_at) ON jellyfin_accounts TO ${role}`);
    await client.query(`GRANT UPDATE(last_activity_at,updated_at) ON jellyfin_accounts TO ${role}`);
    await client.query(`GRANT SELECT(id,customer_id,plan_id,status,current_period_end,created_at,starts_at,superseded_by,service_extension_days,service_type_snapshot,commercial_snapshot) ON subscriptions TO ${role}`);
    await client.query(`GRANT SELECT(id,code,streams,active,service_type,is_free_tier,is_addon,jellyfin_access_model,jellyfin_household_network_limit,jellyfin_household_lease_minutes) ON plans TO ${role}`);
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
        const exists = await client.query('SELECT to_regclass($1) AS table_name', [`public.${table}`]);
        if (exists.rows[0]?.table_name) await client.query(`GRANT INSERT,UPDATE ON ${table} TO ${role}`);
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
module.exports = { ROLE_SPECS, credentialFromUrl, activityCredential, validateDistinctCredentials, configureRoles, main };