'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');

const root=path.resolve(__dirname,'..');
const reseller=['re','seller'].join('');
const credit=['cred','it'].join('');
const retiredCryptoBrand=['coin','gate'].join('');
const forbiddenPatterns=[
  new RegExp(`${reseller}[_ -]?${credit}s?`,'i'),
  new RegExp(`${reseller}[^\n]{0,80}${credit}\\s*(?:balance|based|model|system|wallet|ledger)`,'i'),
  new RegExp(`${credit}\\s*(?:balance|based)[^\n]{0,80}${reseller}`,'i'),
  new RegExp(retiredCryptoBrand,'i')
];
const retiredRootArtifacts=[
  'app.js',
  'secure-start.js',
  'login-rate-limit-preload.js',
  'persistent-session-preload.js',
  'platform-preload.js',
  'staff-auth-preload.js',
  'storefront-preload.js'
];
const ignored=new Set(['.git','node_modules','coverage','test-results']);
const hits=[];
const retiredArtifactReferences=[];

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
    const source=buffer.toString('utf8');
    const lines=source.split(/\r?\n/);
    for(let index=0;index<lines.length;index++){
      if(forbiddenPatterns.some(pattern=>pattern.test(lines[index])))hits.push(`${rel}:${index+1}`);
    }
    if(rel!=='scripts/no-retired-product-traces-smoke.js'){
      for(const artifact of retiredRootArtifacts){
        if(source.includes(artifact))retiredArtifactReferences.push(`${rel} -> ${artifact}`);
      }
    }
  }
}

walk(root);
if(hits.length){
  const files=[...new Set(hits.map(hit=>hit.replace(/:\d+$/,'')))].sort();
  console.error(`Retired commercial/provider traces remain in ${files.length} files (${hits.length} occurrences):`);
  for(const file of files) console.error(`  ${file}`);
}
assert.deepStrictEqual(hits,[],'Retired commercial credit model and retired crypto-provider brand must have no source, route, UI, documentation, test, configuration, or migration traces');
for(const artifact of retiredRootArtifacts){
  assert.strictEqual(fs.existsSync(path.join(root,artifact)),false,`${artifact} is a retired compatibility artifact and must not return`);
}
assert.deepStrictEqual(retiredArtifactReferences,[],'Retired compatibility entry points/preloads must not remain referenced by source, scripts, configuration, documentation, or tests');
assert.strictEqual(fs.existsSync(path.join(root,'src/application.js')),true,'src/application.js must remain the canonical application entry point');
console.log('retired commercial/provider and compatibility-artifact trace audit: ok');
