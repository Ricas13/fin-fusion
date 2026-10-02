'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');

const audit=fs.readFileSync(path.join(root,'scripts/production-acceptance-audit.js'),'utf8');
const deploy=fs.readFileSync(path.join(root,'scripts/deploy-production.sh'),'utf8');
const pkg=require('../package.json');

assert.strictEqual(pkg.scripts['verify:production-acceptance'],'node scripts/production-acceptance-audit.js',
  'production acceptance command must remain stable');

for(const token of [
  "accessIntegrity.scan({limit:500})",
  "providerRecovery.attention({limit:500})",
  "manual_review_required",
  "process.exitCode=2",
  "They were not retried by this audit"
]){
  assert(audit.includes(token),`production acceptance audit missing: ${token}`);
}

for(const token of [
  "Auditing post-cutover production acceptance",
  "npm run verify:production-acceptance",
  "acceptance_rc=0",
  "if [[ \"$acceptance_rc\" == 2 ]]",
  "Production acceptance requires operator review",
  "previous portal readiness probe"
]){
  assert(deploy.includes(token),`deployment acceptance contract missing: ${token}`);
}

const auditAt=deploy.indexOf("Auditing post-cutover production acceptance");
const completeAt=deploy.indexOf("log 'Deployment complete'");
assert(auditAt>=0&&completeAt>auditAt,'production acceptance audit must run before deployment is declared complete');

console.log('production acceptance audit contract: ok');
