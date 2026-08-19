'use strict';

const fs = require('fs');
const path = require('path');

const workflowDir = path.join(__dirname, '..', '.github', 'workflows');
const files = fs.readdirSync(workflowDir).filter(name => /\.ya?ml$/i.test(name)).sort();
const duplicateTriggerFiles = [];

for (const file of files) {
  const source = fs.readFileSync(path.join(workflowDir, file), 'utf8');
  const hasPullRequest = /(^|\n)\s*pull_request\s*:/m.test(source);
  const pushesEveryAgentBranch = source.includes('agent/**');
  if (hasPullRequest && pushesEveryAgentBranch) duplicateTriggerFiles.push(file);
}

if (duplicateTriggerFiles.length) {
  throw new Error(
    'Workflows must not run both pull_request and wildcard agent/** push events: ' +
    duplicateTriggerFiles.join(', ')
  );
}

console.log(`workflow trigger hygiene: ok (${files.length} workflow files, no wildcard agent/PR duplicate triggers)`);
