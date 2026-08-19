'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workflowDir = path.join(root, '.github', 'workflows');
const files = fs.readdirSync(workflowDir).filter(name => /\.ya?ml$/i.test(name)).sort();
const duplicateTriggerFiles = [];
const fastSuiteOwners = [];
const releaseSuiteOwners = [];

for (const file of files) {
  const source = fs.readFileSync(path.join(workflowDir, file), 'utf8');
  const hasPullRequest = /(^|\n)\s*pull_request\s*:/m.test(source);
  const pushesEveryAgentBranch = source.includes('agent/**');
  if (hasPullRequest && pushesEveryAgentBranch) duplicateTriggerFiles.push(file);

  if (/\bnpm run check:fast\b/.test(source) || /\brun:\s*npm run check\s*$/m.test(source)) fastSuiteOwners.push(file);
  if (/\bnpm run check:release\b/.test(source)) releaseSuiteOwners.push(file);
}

if (duplicateTriggerFiles.length) {
  throw new Error(
    'Workflows must not run both pull_request and wildcard agent/** push events: ' +
    duplicateTriggerFiles.join(', ')
  );
}

if (JSON.stringify(fastSuiteOwners) !== JSON.stringify(['ci.yml'])) {
  throw new Error(`check:fast must have exactly one workflow owner (ci.yml); found: ${fastSuiteOwners.join(', ') || 'none'}`);
}
if (releaseSuiteOwners.length) {
  throw new Error(`Workflows must not rerun check:fast transitively through check:release: ${releaseSuiteOwners.join(', ')}`);
}
if (files.includes('lifecycle-integrity.yml')) {
  throw new Error('lifecycle-integrity.yml is redundant; lifecycle coverage belongs to CI + Release Integrity.');
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const fast = String(packageJson.scripts?.['check:fast'] || '');
const db = String(packageJson.scripts?.['check:db'] || '');
const releaseWorkflow = fs.readFileSync(path.join(workflowDir, 'release-integrity.yml'), 'utf8');
const ciWorkflow = fs.readFileSync(path.join(workflowDir, 'ci.yml'), 'utf8');
const adversarialWorkflow = fs.readFileSync(path.join(workflowDir, 'adversarial-concurrency.yml'), 'utf8');
const provisioningWorkflow = fs.readFileSync(path.join(workflowDir, 'provisioning-control.yml'), 'utf8');

if (!fast.includes('lifecycle-provider-scheduling-smoke.js')) {
  throw new Error('Provider scheduling lifecycle coverage must remain in check:fast.');
}
if (!db.includes('lifecycle-integrity-smoke.js')) {
  throw new Error('Lifecycle database contract coverage must remain in check:db.');
}
if (!releaseWorkflow.includes('npm run check:db')) {
  throw new Error('Release Integrity must own check:db.');
}
if (!releaseWorkflow.includes('lifecycle-upgrade-smoke.js')) {
  throw new Error('Release Integrity must retain the previous-schema lifecycle upgrade contract.');
}
if (!ciWorkflow.includes('npm run check')) {
  throw new Error('CI must remain the canonical check:fast owner through npm run check.');
}
if (/\bnpm run check(?::fast|:release)?\b/.test(adversarialWorkflow)) {
  throw new Error('Adversarial Concurrency must run only its unique race/referral tests.');
}
for (const unique of ['adversarial-concurrency-smoke.js', 'referral-safety-smoke.js']) {
  if (!adversarialWorkflow.includes(unique)) throw new Error(`Adversarial workflow lost unique coverage: ${unique}`);
}

if (!fast.includes('provisioning-control-smoke.js')) {
  throw new Error('Pure provisioning-control coverage must remain in check:fast.');
}
if (provisioningWorkflow.includes('provisioning-control-smoke.js')) {
  throw new Error('Provisioning Control must not rerun the pure smoke already owned by CI.');
}
if (!provisioningWorkflow.includes('provisioning-control-db-smoke.js')) {
  throw new Error('Provisioning Control must retain its unique zero-server database integration test.');
}

console.log(`workflow trigger/suite hygiene: ok (${files.length} workflows; fast suite owned by CI; lifecycle/provisioning duplicates removed)`);
