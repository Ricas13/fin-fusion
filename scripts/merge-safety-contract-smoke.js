'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');

const workflow=fs.readFileSync(path.join(root,'.github/workflows/merge-safety.yml'),'utf8');
const deploy=fs.readFileSync(path.join(root,'scripts/deploy-production.sh'),'utf8');

for(const token of [
  'name: Merge Safety',
  'pull_request:',
  'fetch-depth: 0',
  'Prove N-1 web runtime survives candidate schema',
  'git worktree add --detach /tmp/captainfin-base',
  'Build exact production image',
  'CAPTAINFIN_BUILD_SHA="$GITHUB_SHA"',
  'Start candidate production workers',
  'Candidate deployment verification before web cutover',
  'captainfin:merge-safety npm run verify:deployment',
  'Boot candidate web image and hold readiness',
  'curl -fsS http://127.0.0.1:3030/health/ready'
]) assert(workflow.includes(token),`Merge Safety contract missing: ${token}`);

const migrationAt=deploy.indexOf('docker compose run --rm --no-deps migrate');
const verifyAt=deploy.indexOf('docker compose run --rm --no-deps app npm run verify:deployment');
const cutoverAt=deploy.indexOf("log 'Candidate verified; switching the customer-facing web application'");
assert(migrationAt>=0&&verifyAt>migrationAt&&cutoverAt>verifyAt,'production deploy must migrate -> candidate verify -> live web cutover');
assert(!deploy.includes('docker compose stop --timeout 45 app automation-worker activity-worker backup-worker'),'production deploy must not drain the portal before candidate verification');
assert(deploy.includes('keeping the current portal live'),'deployment log must make availability-preserving behavior explicit');
assert(deploy.includes('previous web application remained serving throughout'),'pre-cutover rollback must preserve the existing portal');
assert(deploy.includes('Proving the currently serving portal remains healthy on the migrated schema'),'production must prove N-1 compatibility after migration');

console.log('merge safety contract: ok');
