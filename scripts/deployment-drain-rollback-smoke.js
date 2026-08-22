'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const deploy = fs.readFileSync(path.join(__dirname, 'deploy-production.sh'), 'utf8');

for (const token of [
  "previous_app_image=\"$(docker inspect -f '{{.Image}}' steam-fusion",
  "previous_automation_image=\"$(docker inspect -f '{{.Image}}' steam-fusion-automation",
  "previous_activity_image=\"$(docker inspect -f '{{.Image}}' steam-fusion-activity",
  "previous_backup_image=\"$(docker inspect -f '{{.Image}}' steam-fusion-backup",
  'git diff --quiet "$previous_deploy_sha"..HEAD -- db/migrations',
  "docker compose stop --timeout 45 app automation-worker activity-worker backup-worker",
  'migration_started=1',
  '--no-deps --no-build --force-recreate',
  'Automatic runtime rollback suppressed: database migrations changed in this release.',
  'Previous runtime images restored. Database contents were not rolled back.'
]) {
  assert(deploy.includes(token), `deployment drain/rollback contract missing: ${token}`);
}

const backup = deploy.indexOf('recovery-tools npm run db:backup');
const stop = deploy.indexOf('docker compose stop --timeout 45 app automation-worker activity-worker backup-worker');
const migrate = deploy.indexOf('docker compose run --rm --no-deps migrate');
const recreate = deploy.indexOf('docker compose up -d --no-deps app automation-worker activity-worker backup-worker');
const verify = deploy.indexOf('docker compose exec -T app npm run verify:deployment');
assert(backup >= 0 && backup < stop, 'encrypted pre-deploy backup must complete before runtime drain');
assert(stop < migrate, 'old runtime must be stopped before schema migration starts');
assert(migrate < recreate, 'new runtime must not be recreated until migration succeeds');
assert(recreate < verify, 'deployment verification must run against recreated services');

assert(deploy.includes('if [[ "$migration_started" == 0 || "$rollback_safe" == 1 ]]'), 'rollback must be allowed before migration or when no migration files changed');
assert(!/pg_restore/.test(deploy), 'normal deployment failure handling must never perform an automatic database restore');
assert(deploy.includes('Use the encrypted pre-deploy backup and recovery tooling if database rollback is required.'), 'migration-bearing rollback must direct the operator to explicit recovery tooling');

console.log('deployment drain/rollback smoke passed');
