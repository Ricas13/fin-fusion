'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');

const REQUIRED=Object.freeze({
  'CI':'.github/workflows/ci.yml',
  'Release Integrity':'.github/workflows/release-integrity.yml',
  'Integration':'.github/workflows/integration.yml',
  'Browser & Clean Install':'.github/workflows/browser.yml',
  'Security CodeQL':'.github/workflows/security-codeql.yml',
  'Stremio':'.github/workflows/stremio.yml',
  'Merge Safety':'.github/workflows/merge-safety.yml'
});

const contract=fs.readFileSync(path.join(root,'docs/REPOSITORY_MERGE_GATES.md'),'utf8');
for(const [name,file] of Object.entries(REQUIRED)){
  const source=fs.readFileSync(path.join(root,file),'utf8');
  assert(source.split(/\r?\n/).some(line=>line.trim()===`name: ${name}`), `${file} must retain workflow name ${name}`);
  assert(/^\s*pull_request:\s*$/m.test(source), `${name} must run for pull requests so it can serve as a merge gate`);
  assert(contract.includes(`- ${name}`), `merge-gate contract must document ${name}`);
}
assert(contract.includes('exact PR head'), 'merge-gate contract must reject relying on green checks from an older PR head');
assert(/up to date with `main`|merge queue/i.test(contract), 'merge-gate contract must document current-base or merge-queue enforcement');
assert(/owner bypass|repository-owner bypass/i.test(contract), 'merge-gate contract must make emergency override behavior explicit');
const mergeSafety=fs.readFileSync(path.join(root,'.github/workflows/merge-safety.yml'),'utf8');
assert(mergeSafety.includes('Prove N-1 web runtime survives candidate schema'),'Merge Safety must prove previous-runtime schema compatibility');
assert(mergeSafety.includes('Build exact production image'),'Merge Safety must build the exact production image');
assert(mergeSafety.includes('Candidate deployment verification before web cutover'),'Merge Safety must run deployment verification before web cutover');
assert(mergeSafety.includes('Boot candidate web image and hold readiness'),'Merge Safety must hold candidate web readiness after boot');

console.log('repository merge-gate source contract: ok');
