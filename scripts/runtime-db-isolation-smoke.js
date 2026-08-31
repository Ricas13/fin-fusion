'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('./migration-id-smoke');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const compose = read('docker-compose.yml');
const roleScript = read('scripts/configure-runtime-db-roles.js');
const verifyBackup = read('scripts/verify-backup.js');
const sessionMigration = read('db/migrations/002_add_runtime_session_store.sql');
const deletionMigration = read('db/migrations/100_customer_deletion_saga.sql');
const hardeningMigration = read('db/migrations/20260829170000_database_operational_hardening.sql');
const retentionOwner = read('src/automation/data-retention.js');
const automationJobs = read('src/automation/jobs.js');

function service(name) {
    const match = new RegExp(`(^|\\r?\\n)  ${name}:\\r?\\n`).exec(compose);
    assert(match, `missing compose service ${name}`);
    const start = match.index + match[1].length;
    const rest = compose.slice(start + match[0].length - match[1].length);
    const next = rest.search(/\r?\n  [a-zA-Z0-9][a-zA-Z0-9_-]*:\r?\n/);
    return next < 0 ? compose.slice(start) : compose.slice(start, start + match[0].length - match[1].length + next);
}

const migrate = service('migrate');
const app = service('app');
const automation = service('automation-worker');
const activity = service('activity-worker');
const backup = service('backup-worker');
const recovery = service('recovery-tools');
const grantAppBlock = roleScript.slice(roleScript.indexOf('async function grantApp'), roleScript.indexOf('async function grantAutomation'));

assert(/npm run db:migrate/.test(migrate) && /npm run db:runtime-roles/.test(migrate), 'migrate must refresh isolated runtime roles after schema migration');
assert(migrate.indexOf('npm run db:migrate') < migrate.indexOf('npm run db:runtime-roles'), 'runtime grants must be refreshed after migrations');
assert(migrate.indexOf('npm run db:runtime-roles') < migrate.indexOf('npm run auth:bootstrap'), 'runtime grants must be ready before application startup/bootstrap completes');

for (const [name, block] of [['app', app], ['automation-worker', automation], ['activity-worker', activity], ['backup-worker', backup]]) assert(!/\benv_file\s*:/.test(block), `${name} must not inherit the privileged .env wholesale`);
assert(/DATABASE_URL:\s*\$\{APP_DATABASE_URL:\?/.test(app), 'app must use APP_DATABASE_URL');
assert(/DATABASE_URL:\s*\$\{AUTOMATION_DATABASE_URL:\?/.test(automation), 'automation worker must use AUTOMATION_DATABASE_URL');
assert(/ACTIVITY_DATABASE_URL:\s*\$\{ACTIVITY_DATABASE_URL:\?/.test(activity), 'activity worker must use ACTIVITY_DATABASE_URL');
assert(/DATABASE_URL:\s*\$\{BACKUP_DATABASE_URL:\?/.test(backup), 'backup worker must use BACKUP_DATABASE_URL');
assert(/BACKUP_VERIFY_DATABASE_URL:\s*\$\{BACKUP_VERIFY_DATABASE_URL:\?/.test(backup), 'backup worker must use a separate verification login');
assert(/DATABASE_URL:\s*\$\{DATABASE_URL:\?/.test(recovery), 'recovery tools intentionally keep the owner/recovery credential');
assert(/STREMIO_JELLYFIN_TOKEN_KEY:\s*\$\{STREMIO_JELLYFIN_TOKEN_KEY/.test(app), 'only the web runtime should receive the Stremio restricted-token purpose key');
for (const secret of ['BACKUP_ENCRYPTION_KEY','ACTIVITY_ENCRYPTION_KEY','ACTIVITY_DATABASE_URL','BACKUP_DATABASE_URL','BACKUP_VERIFY_DATABASE_URL']) assert(!app.includes(`${secret}:`), `app must not receive ${secret}`);
for (const secret of ['SESSION_SECRET','AUTH_ENCRYPTION_KEY','BACKUP_ENCRYPTION_KEY','ACTIVITY_ENCRYPTION_KEY','ADMIN_PASSWORD','STREMIO_JELLYFIN_TOKEN_KEY']) assert(!automation.includes(`${secret}:`), `automation worker must not receive ${secret}`);
for (const block of [activity,backup]) assert(!block.includes('STREMIO_JELLYFIN_TOKEN_KEY:'),'activity/backup workers must not receive the Stremio token purpose key');
for (const secret of ['SESSION_SECRET','AUTH_ENCRYPTION_KEY','DATA_ENCRYPTION_KEY','JELLYFIN_ENCRYPTION_KEY','ACTIVITY_ENCRYPTION_KEY','ADMIN_PASSWORD']) assert(!backup.includes(`${secret}:`), `backup worker must not receive ${secret}`);

for (const role of ['steamfusion_app','steamfusion_automation','steamfusion_activity','steamfusion_backup','steamfusion_backup_verify']) assert(roleScript.includes(role), `role bootstrap is missing ${role}`);
assert(/GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO \$\{role\}/.test(grantAppBlock), 'web compatibility grants must exclude blanket DELETE');
assert(!/GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public/.test(grantAppBlock), 'web app must never regain blanket DELETE');
assert(roleScript.includes('APP_DELETE_TABLES') && roleScript.includes("'user_sessions'") && roleScript.includes("'jellyfin_accounts'"), 'web DELETE must be an explicit reviewed allowlist');
assert(roleScript.includes('APP_APPEND_ONLY_TABLES') && roleScript.includes("'auth_events'") && roleScript.includes("'subscription_service_extension_events'"), 'append-only web tables must be explicitly non-updatable');
assert(roleScript.includes('APP_READ_ONLY_TABLES') && roleScript.includes("'schema_migrations'") && roleScript.includes("'playback_history'"), 'worker-owned/history tables must be read-only to the web role');
assert(/REVOKE DELETE ON provider_operations FROM \$\{role\}/.test(grantAppBlock), 'web app must not delete provider operation recovery state');
assert(/REVOKE DELETE ON payment_events FROM \$\{role\}/.test(grantAppBlock), 'web app must not delete payment event processing state');
assert(/REVOKE DELETE ON subscriptions FROM \$\{role\}/.test(grantAppBlock), 'web app must not directly delete subscriptions');
assert(/REVOKE DELETE ON customers FROM \$\{role\}/.test(grantAppBlock), 'web app must finalize customer deletion through the canonical owner');
assert(/ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM \$\{spec.role\}/.test(roleScript), 'future tables must not inherit runtime CRUD');
assert(/ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/.test(roleScript), 'future functions must require deliberate EXECUTE grants');
assert(/'schema_migrations','user_sessions'/.test(roleScript), 'automation role must not receive migration/session-store access');
assert(/GRANT SELECT ON ALL TABLES IN SCHEMA public TO \$\{role\}/.test(roleScript), 'backup role must be read-capable for complete pg_dump snapshots');
assert(/GRANT INSERT,UPDATE ON \$\{table\} TO \$\{role\}/.test(roleScript), 'backup role must write only its bookkeeping tables');
assert(/backupVerify:\s*\{[^}]*createdb:\s*true/.test(roleScript) && /async function grantBackupVerify[\s\S]*?REVOKE ALL ON SCHEMA public FROM \$\{role\}[\s\S]*?REVOKE ALL ON ALL TABLES IN SCHEMA public FROM \$\{role\}[\s\S]*?REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM \$\{role\}/.test(roleScript), 'restore verifier must use a CREATEDB-only identity with no production schema/table/sequence grants');
assert(/auth_totp_enrollments/.test(roleScript) && /auth_sessions/.test(roleScript), 'automation role must explicitly exclude authentication secrets');
assert(/REVOKE INSERT,UPDATE,DELETE ON app_users FROM \$\{role\}/.test(roleScript)&&/'auth_sessions','auth_events'/.test(roleScript),'automation must remain unable to mutate portal users or authentication history directly');
assert(roleScript.includes('grantDeletionFinalizer(client, role)')&&roleScript.includes('GRANT EXECUTE ON FUNCTION public.finalize_customer_deletion(uuid) TO ${role}'),'app and automation may finalize deletion only through the constrained function');
assert(deletionMigration.includes('SECURITY DEFINER')&&deletionMigration.includes("REVOKE ALL ON FUNCTION public.finalize_customer_deletion(uuid) FROM PUBLIC"),'customer deletion finalizer must be security-definer and unavailable to PUBLIC');
assert(deletionMigration.includes("j.status <> 'running'")&&deletionMigration.includes('COALESCE(confirmed_accounts,0) <> expected_accounts'),'privileged deletion finalizer must reject non-running or incompletely confirmed remote deletion jobs');

assert(hardeningMigration.includes('SECURITY DEFINER') && hardeningMigration.includes('run_data_retention_batch'), 'retention must have one constrained database owner');
assert(hardeningMigration.includes("state IN ('reconciled','compensated')") && !hardeningMigration.includes("state IN ('failed'"), 'provider retention must only remove terminal converged state');
assert(hardeningMigration.includes('processed_at IS NOT NULL') && hardeningMigration.includes('processing_error IS NULL'), 'payment retention must preserve pending/problem events');
assert(hardeningMigration.includes('FOR UPDATE SKIP LOCKED') && hardeningMigration.includes('LIMIT v_limit'), 'retention deletes must be bounded and concurrency-safe');
assert(hardeningMigration.includes('access_network_leases_expiry_idx') || read('db/migrations/023_modular_access_drivers.sql').includes('access_network_leases_expiry_idx'), 'network lease cleanup must use the expiry index');
assert(hardeningMigration.includes('cleanup_expired_access_network_leases') && automationJobs.includes('data_retention(){return dataRetention.run()}'), 'expired lease cleanup must be scheduled through canonical retention automation');
assert(retentionOwner.includes('batchSize: 500') && retentionOwner.includes('paymentEventDays: 365') && retentionOwner.includes('auditLogDays: 730'), 'retention defaults must be explicit and configurable by data class');
assert(!hardeningMigration.includes('DELETE FROM affiliate_credit_ledger') && !hardeningMigration.includes('DELETE FROM subscriptions'), 'financial/accounting ledgers and subscriptions are not housekeeping data');

assert(/GRANT UPDATE\(last_activity_at,updated_at\) ON jellyfin_accounts TO \$\{role\}/.test(roleScript), 'activity role must be able to advance only Jellyfin activity bookkeeping columns');
assert(/GRANT SELECT\(id,customer_id,server_id,jellyfin_user_id,disabled,account_purpose,access_lane,last_activity_at\) ON jellyfin_accounts TO \$\{role\}/.test(roleScript), 'activity role must read the lane on managed Jellyfin accounts without broad table access');
assert(/GRANT SELECT\(id,name,slug,server_class,media_server_type,base_url,public_url,enabled,priority,max_users,health_status,last_health_check,api_key_encrypted\) ON jellyfin_servers TO \$\{role\}/.test(roleScript), 'activity role must read provider type only alongside the media-server fields required for trusted API calls');
assert(/GRANT SELECT\(id,customer_id,plan_id,status,source,provider_subscription_id,current_period_end,created_at,starts_at,superseded_by,service_extension_days,service_type_snapshot,commercial_snapshot\) ON subscriptions TO \$\{role\}/.test(roleScript), 'activity role must read contractual lane fields plus the minimum provider identity needed to distinguish one-time access from recurring access');
assert(/GRANT SELECT\(id,code,streams,active,service_type,is_free_tier,is_addon,jellyfin_access_model,jellyfin_household_network_limit,jellyfin_household_lease_minutes\) ON plans TO \$\{role\}/.test(roleScript), 'activity role must distinguish free and primary plan lanes');
assert(/GRANT SELECT\(customer_id,access_lane,streams\) ON customer_lane_policy_overrides TO \$\{role\}/.test(roleScript), 'activity role must read only lane stream overrides, not unrelated customer policy');
assert(/GRANT SELECT\(customer_id,subscription_id,permanent_access,revoked_at\) ON customer_entitlement_overrides TO \$\{role\}/.test(roleScript), 'activity role must honour permanent access without broad entitlement mutation rights');
assert(!/GRANT (SELECT,)?INSERT.*customer_lane_policy_overrides TO \$\{role\}/.test(roleScript), 'activity role must never mutate lane policy overrides');

assert(/CREATE TABLE IF NOT EXISTS user_sessions/.test(sessionMigration), 'runtime session table must be migration-owned');
for (const column of ['sid VARCHAR','sess JSON','expire TIMESTAMP']) assert(sessionMigration.includes(column), `session migration is missing ${column}`);
assert(/PRIMARY KEY \(sid\)/.test(sessionMigration) && /user_sessions\(expire\)/.test(sessionMigration), 'session migration must include its key and expiry index');
assert(/BACKUP_VERIFY_DATABASE_URL/.test(verifyBackup), 'restore verification must use the dedicated verifier credential');
assert(!/fs\.existsSync\(input\)/.test(verifyBackup), 'backup verification must not use check-then-open file validation');
assert(/O_NOFOLLOW/.test(verifyBackup) && /fstatSync\(fd\)/.test(verifyBackup) && /parseHeaderFromFd\(inputFd\)/.test(verifyBackup), 'backup verification must bind validation and decryption to one descriptor');
assert(!/const adminUrl=dbUrlFor\(base,'postgres'\)/.test(verifyBackup), 'restore verification must not derive CREATE DATABASE access from the production backup login');
console.log('runtime database isolation smoke: ok');
