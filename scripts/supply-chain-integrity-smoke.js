#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const errors = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function fail(message) {
  errors.push(message);
}

const workflowDir = path.join(root, '.github', 'workflows');
const workflowFiles = fs.readdirSync(workflowDir)
  .filter(name => /\.ya?ml$/i.test(name))
  .sort();

for (const name of workflowFiles) {
  const relativePath = path.posix.join('.github', 'workflows', name);
  const lines = read(relativePath).split(/\r?\n/);

  lines.forEach((line, index) => {
    const uses = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
    if (uses) {
      const reference = uses[1];
      if (!reference.startsWith('./') && !reference.startsWith('docker://')) {
        const at = reference.lastIndexOf('@');
        if (at < 1) {
          fail(`${relativePath}:${index + 1} external action has no immutable ref: ${reference}`);
        } else {
          const revision = reference.slice(at + 1);
          if (!/^[0-9a-f]{40}$/i.test(revision)) {
            fail(`${relativePath}:${index + 1} external action must be pinned to a full 40-character commit SHA: ${reference}`);
          }
        }
      }
    }

    const image = line.match(/^\s*image:\s*([^\s#]+)/);
    if (image && !/@sha256:[0-9a-f]{64}$/i.test(image[1])) {
      fail(`${relativePath}:${index + 1} workflow service image must be digest pinned: ${image[1]}`);
    }

    // Only inspect explicit `docker run` image arguments here. PostgreSQL
    // connection strings such as postgres://user:password@host are credentials,
    // not image references, and must never be mistaken for floating images.
    if (/\bdocker\s+run\b/.test(line)) {
      const dockerImages = line.match(/\b(?:postgres|node):[A-Za-z0-9._-]+(?:@sha256:[0-9a-f]{64})?/gi) || [];
      for (const reference of dockerImages) {
        if (!/@sha256:[0-9a-f]{64}$/i.test(reference)) {
          fail(`${relativePath}:${index + 1} docker run image reference must be digest pinned: ${reference}`);
        }
      }
    }
  });
}

const dockerfileLines = read('Dockerfile').split(/\r?\n/);
dockerfileLines.forEach((line, index) => {
  const from = line.match(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+\S+)?/i);
  if (!from || from[1].toLowerCase() === 'scratch') return;
  if (!/@sha256:[0-9a-f]{64}$/i.test(from[1])) {
    fail(`Dockerfile:${index + 1} base image must be digest pinned: ${from[1]}`);
  }
});

const composeLines = read('docker-compose.yml').split(/\r?\n/);
composeLines.forEach((line, index) => {
  const image = line.match(/^\s*image:\s*([^\s#]+)/);
  if (image && !/@sha256:[0-9a-f]{64}$/i.test(image[1])) {
    fail(`docker-compose.yml:${index + 1} service image must be digest pinned: ${image[1]}`);
  }
});

const dependabotPath = path.join(root, '.github', 'dependabot.yml');
if (!fs.existsSync(dependabotPath)) {
  fail('.github/dependabot.yml is required so immutable pins remain maintainable');
} else {
  const dependabot = fs.readFileSync(dependabotPath, 'utf8');
  for (const ecosystem of ['github-actions', 'docker']) {
    if (!new RegExp(`package-ecosystem:\\s*["']?${ecosystem}["']?`).test(dependabot)) {
      fail(`.github/dependabot.yml must update the ${ecosystem} ecosystem`);
    }
  }
}

if (errors.length) {
  console.error('Supply-chain integrity checks failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Supply-chain integrity checks passed across ${workflowFiles.length} workflows.`);
