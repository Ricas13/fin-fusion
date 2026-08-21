'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');

const root=path.resolve(__dirname,'..');
const reseller=['re','seller'].join('');
const credit=['cred','it'].join('');
const forbiddenPatterns=[
  new RegExp(`${reseller}[_ -]?${credit}s?`,'i'),
  new RegExp(`${reseller}[^\\n]{0,80}${credit}\\s*(?:balance|based|model|system|wallet|ledger)`,'i'),
  new RegExp(`${credit}\\s*(?:balance|based)[^\\n]{0,80}${reseller}`,'i')
];
const ignored=new Set(['.git','node_modules','coverage','test-results']);
const hits=[];

function looksText(buffer){
  const sample=buffer.subarray(0,Math.min(buffer.length,4096));
  return !sample.includes(0);
}

function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(ignored.has(entry.name)) continue;
    const full=path.join(dir,entry.name);
    const rel=path.relative(root,full).replace(/\\/g,'/');
    if(entry.isDirectory()){walk(full);continue;}
    if(!entry.isFile()) continue;
    const buffer=fs.readFileSync(full);
    if(!looksText(buffer)) continue;
    const lines=buffer.toString('utf8').split(/\r?\n/);
    for(let index=0;index<lines.length;index++){
      if(forbiddenPatterns.some(pattern=>pattern.test(lines[index])))hits.push(`${rel}:${index+1}`);
    }
  }
}

walk(root);
if(hits.length){
  const files=[...new Set(hits.map(hit=>hit.replace(/:\d+$/,'')))].sort();
  console.error(`Retired commercial-credit traces remain in ${files.length} files (${hits.length} occurrences):`);
  for(const file of files) console.error(`  ${file}`);
}
assert.deepStrictEqual(hits,[],'Retired commercial credit model must have no source, route, UI, documentation, test, configuration, or migration traces');
console.log('retired commercial credit-model trace audit: ok');
