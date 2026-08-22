#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.argv[2] || 'test-results/release-evidence');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sha256File(relativePath) {
  const contents = fs.readFileSync(path.join(root, relativePath));
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function workflowFiles() {
  const directory = path.join(root, '.github', 'workflows');
  return fs.readdirSync(directory)
    .filter(name => /\.ya?ml$/i.test(name))
    .sort()
    .map(name => path.posix.join('.github', 'workflows', name));
}

function collectSupplyChainRefs() {
  const actions = [];
  const images = [];

  for (const relativePath of workflowFiles()) {
    for (const line of read(relativePath).split(/\r?\n/)) {
      const uses = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
      if (uses && !uses[1].startsWith('./')) actions.push(uses[1]);

      const image = line.match(/^\s*image:\s*([^\s#]+)/);
      if (image) images.push(image[1]);

      const dockerRuns = line.match(/\b(?:postgres|node):[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}\b/gi) || [];
      images.push(...dockerRuns);
    }
  }

  for (const line of read('Dockerfile').split(/\r?\n/)) {
    const from = line.match(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+\S+)?/i);
    if (from && from[1].toLowerCase() !== 'scratch') images.push(from[1]);
  }

  for (const line of read('docker-compose.yml').split(/\r?\n/)) {
    const image = line.match(/^\s*image:\s*([^\s#]+)/);
    if (image) images.push(image[1]);
  }

  return {
    actions: uniqueSorted(actions),
    images: uniqueSorted(images)
  };
}

function npmVersion() {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  } catch (_) {
    return null;
  }
}

fs.mkdirSync(outputDir, { recursive: true });

const trackedFiles = [
  'package.json',
  'package-lock.json',
  'Dockerfile',
  'docker-compose.yml',
  '.github/dependabot.yml',
  ...workflowFiles()
];

const files = Object.fromEntries(trackedFiles.map(relativePath => [relativePath, sha256File(relativePath)]));
const refs = collectSupplyChainRefs();

const provenance = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    repository: process.env.GITHUB_REPOSITORY || 'Ricas13/fin-fusion',
    commit: process.env.GITHUB_SHA || null,
    ref: process.env.GITHUB_REF || null
  },
  workflow: {
    name: process.env.GITHUB_WORKFLOW || null,
    job: process.env.GITHUB_JOB || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null
  },
  runtime: {
    node: process.version,
    npm: npmVersion()
  },
  files,
  actions: refs.actions,
  images: refs.images
};

fs.writeFileSync(
  path.join(outputDir, 'provenance.json'),
  `${JSON.stringify(provenance, null, 2)}\n`,
  { mode: 0o644 }
);

const checksumLines = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([relativePath, hash]) => `${hash}  ${relativePath}`);
fs.writeFileSync(
  path.join(outputDir, 'checksums.sha256'),
  `${checksumLines.join('\n')}\n`,
  { mode: 0o644 }
);

console.log(`Release provenance written to ${path.relative(root, outputDir) || '.'}.`);
