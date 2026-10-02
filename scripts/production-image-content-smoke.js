'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const dockerignore=fs.readFileSync(path.join(root,'.dockerignore'),'utf8');
const dockerfile=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');

for(const ignored of [
  'docs',
  'scripts/*/README.md',
  'scripts/ci',
  'scripts/*-smoke.js',
  'scripts/db-test-fixture.js',
  'scripts/test-fixture.js',
  'scripts/smoke-db.js',
  'scripts/*-audit.js',
  'scripts/check-*.js',
  'scripts/dead-code-audit.js',
  'scripts/compatibility-importer-report.js',
  'scripts/run-check-suite.js',
  'scripts/run-tagged-checks.js'
]){
  assert(dockerignore.split(/\r?\n/).map(line=>line.trim()).includes(ignored),
    `.dockerignore must exclude CI-only runtime-image material: ${ignored}`);
}

const requiredRuntimeScripts=[
  'scripts/automation-worker.js',
  'scripts/activity-worker.js',
  'scripts/backup-worker.js',
  'scripts/backup-healthcheck.js',
  'scripts/migrate-db.js',
  'scripts/configure-runtime-db-roles.js',
  'scripts/bootstrap-admin.js',
  'scripts/backup-db.js',
  'scripts/inspect-backup.js',
  'scripts/verify-backup.js',
  'scripts/restore-db.js',
  'scripts/verify-deployment.js'
];
for(const file of requiredRuntimeScripts){
  assert(fs.existsSync(path.join(root,file)),`required runtime/operator script is missing: ${file}`);
  assert(!/-smoke\.js$/.test(file)&&!/^scripts\/check-/.test(file),
    `required runtime script would be removed by the CI-only ignore patterns: ${file}`);
}
assert(dockerfile.includes('COPY . .'),'image-content contract assumes source COPY is filtered by .dockerignore');
assert(dockerfile.includes('npm ci --omit=dev --ignore-scripts'),'production image must retain production-only dependency installation');

console.log('production image content contract: ok');
