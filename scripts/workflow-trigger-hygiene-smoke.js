'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workflowDir = path.join(root, '.github', 'workflows');
const files = fs.readdirSync(workflowDir).filter(name => /\.ya?ml$/i.test(name)).sort();
const expectedFiles = [
  'branch-hygiene.yml',
  'browser.yml',
  'ci.yml',
  'integration.yml',
  'release-integrity.yml',
  'security-codeql.yml',
  'stremio.yml',
];

if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `Workflow inventory drifted. Expected exactly ${expectedFiles.length}: ${expectedFiles.join(', ')}; ` +
    `found ${files.length}: ${files.join(', ') || 'none'}`
  );
}

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

const branchHygieneWorkflow = fs.readFileSync(path.join(workflowDir, 'branch-hygiene.yml'), 'utf8');
if (/(^|\n)\s*pull_request\s*:/m.test(branchHygieneWorkflow)) {
  throw new Error('Branch hygiene must never run from an untrusted pull_request context.');
}
if (!branchHygieneWorkflow.includes('contents: write')) {
  throw new Error('Branch hygiene must declare the repository-content permission required to delete refs.');
}
if (branchHygieneWorkflow.includes('pull-requests: write') || branchHygieneWorkflow.includes('actions: write')) {
  throw new Error('Branch hygiene must not request unrelated pull-request or Actions write permissions.');
}
if (!branchHygieneWorkflow.includes('git merge-base --is-ancestor "origin/$branch" origin/main')) {
  throw new Error('Branch hygiene must prove a branch tip is fully contained in main before deletion.');
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const fast = String(packageJson.scripts?.['check:fast'] || '');
const db = String(packageJson.scripts?.['check:db'] || '');
const releaseWorkflow = fs.readFileSync(path.join(workflowDir, 'release-integrity.yml'), 'utf8');
const ciWorkflow = fs.readFileSync(path.join(workflowDir, 'ci.yml'), 'utf8');
const integrationWorkflow = fs.readFileSync(path.join(workflowDir, 'integration.yml'), 'utf8');
const integrationRunner = fs.readFileSync(path.join(root, 'scripts', 'ci-integration-suite.js'), 'utf8');

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
if (!integrationWorkflow.includes('node scripts/ci-integration-suite.js')) {
  throw new Error('Integration workflow must execute the centralized database integration suite.');
}

for (const unique of [
  'adversarial-concurrency-smoke.js',
  'referral-safety-smoke.js',
  'provisioning-control-db-smoke.js',
  'affiliate-service-credit-smoke.js',
  'configuration-transfer-smoke.js',
  'server-migration-smoke.js',
  'transactional-email-smoke.js',
]) {
  if (!integrationRunner.includes(unique)) {
    throw new Error(`Central integration suite lost unique coverage: ${unique}`);
  }
}

if (!fast.includes('provisioning-control-smoke.js')) {
  throw new Error('Pure provisioning-control coverage must remain in check:fast.');
}
if (integrationRunner.includes("['scripts/provisioning-control-smoke.js']")) {
  throw new Error('Integration suite must not rerun the pure provisioning smoke already owned by CI.');
}

console.log(
  `workflow trigger/suite hygiene: ok (${files.length} workflows; ` +
  'CI owns fast checks; Integration owns isolated feature DB checks; Release owns DB release checks)'
);
