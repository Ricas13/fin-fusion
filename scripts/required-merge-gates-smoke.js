'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const required=[
  'CI',
  'Release Integrity',
  'Integration',
  'Browser & Clean Install',
  'Security CodeQL',
  'Stremio',
  'Merge Safety'
];

const docs=fs.readFileSync(path.join(root,'docs','REQUIRED_MERGE_GATES.md'),'utf8');
const workflowDir=path.join(root,'.github','workflows');
const workflowNames=fs.readdirSync(workflowDir)
  .filter(name=>/\.ya?ml$/i.test(name))
  .map(name=>{
    const source=fs.readFileSync(path.join(workflowDir,name),'utf8');
    const match=source.match(/^name:\s*(.+?)\s*$/m);
    return match?match[1].trim():null;
  })
  .filter(Boolean);

for(const gate of required){
  assert(workflowNames.includes(gate),`required merge workflow is missing or renamed: ${gate}`);
  assert(docs.includes(`- ${gate}`),`required merge gate documentation is missing: ${gate}`);
}

assert(/current with the target branch/i.test(docs),'merge policy must require current-base validation');
assert(/Emergency or owner bypass/i.test(docs),'merge policy must explicitly document emergency/owner override semantics');
assert(/N-1 web\/schema compatibility/i.test(docs)&&/exact production image/i.test(docs),'merge policy must document the production-grade Merge Safety proof');

console.log('required merge gates documentation smoke: ok');
