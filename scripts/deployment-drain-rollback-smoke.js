'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const deploy = fs.readFileSync(path.join(__dirname, 'deploy-production.sh'), 'utf8');

for (const pair of [
  'adopt_legacy_container captainfin steam-fusion',
  'adopt_legacy_container captainfin-automation steam-fusion-automation',
  'adopt_legacy_container captainfin-activity steam-fusion-activity',
  'adopt_legacy_container captainfin-backup steam-fusion-backup',
  'adopt_legacy_container captainfin-postgres steam-fusion-postgres'
]) {
  assert(deploy.includes(pair), `deployment must adopt legacy runtime identity: ${pair}`);
}

for (const token of [
  'previous_app_image="$(compose_service_image_id app)"',
  'previous_automation_image="$(compose_service_image_id automation-worker)"',
  'previous_activity_image="$(compose_service_image_id activity-worker)"',
  'previous_backup_image="$(compose_service_image_id backup-worker)"',
  'git diff --quiet "$previous_deploy_sha"..HEAD -- db/migrations',
  "docker compose stop --timeout 45 automation-worker activity-worker backup-worker",
  'migration_started=1',
  '--no-deps --no-build --force-recreate',
  'Automatic runtime rollback suppressed: database migrations changed in this release.',
  'Previous runtime images restored. Database contents were not rolled back.'
]) {
  assert(deploy.includes(token), `deployment drain/rollback contract missing: ${token}`);
}

const backup = deploy.indexOf('recovery-tools npm run db:backup');
const stop = deploy.indexOf('docker compose stop --timeout 45 automation-worker activity-worker backup-worker');
const migrate = deploy.indexOf('docker compose run --rm --no-deps migrate');
const workers = deploy.indexOf('docker compose up -d --no-deps automation-worker activity-worker backup-worker');
const verify = deploy.indexOf('docker compose run --rm --no-deps app npm run verify:deployment');
const appCutover = deploy.indexOf('docker compose up -d --no-deps app', verify);
assert(backup >= 0 && backup < stop, 'encrypted pre-deploy backup must complete before worker drain');
assert(stop < migrate, 'background workers must be stopped before schema migration starts');
assert(migrate < workers, 'candidate workers must not start until migration succeeds');
assert(workers < verify, 'candidate deployment verification must run after candidate workers start');
assert(verify < appCutover, 'live web application must not be replaced until candidate verification succeeds');
assert(!deploy.includes('docker compose stop --timeout 45 app '),'deployment must never intentionally stop the live portal before candidate verification');

assert(deploy.includes('if [[ "$migration_started" == 0 || "$rollback_safe" == 1 ]]'), 'rollback must remain gated by proven schema compatibility');
assert(deploy.includes("Proving the currently serving portal remains healthy on the migrated schema"),'production deploy must prove N-1 compatibility before declaring rollback safe');
assert(deploy.includes('rollback_services=(automation-worker activity-worker backup-worker)'),'pre-cutover rollback must restore workers without recreating the live app');
assert(!/pg_restore/.test(deploy), 'normal deployment failure handling must never perform an automatic database restore');
assert(deploy.includes('Use the encrypted pre-deploy backup and recovery tooling if database rollback is required.'), 'migration-bearing rollback must direct the operator to explicit recovery tooling');

console.log('deployment drain/rollback smoke passed');
