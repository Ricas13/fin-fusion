'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');

const root=path.resolve(__dirname,'..');
const forbidden=['re','seller'].join('');
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
    if(rel.toLowerCase().includes(forbidden)) hits.push(`${rel} (path)`);
    if(entry.isDirectory()){walk(full);continue;}
    if(!entry.isFile()) continue;
    const buffer=fs.readFileSync(full);
    if(!looksText(buffer)) continue;
    const lines=buffer.toString('utf8').split(/\r?\n/);
    for(let index=0;index<lines.length;index++){
      if(lines[index].toLowerCase().includes(forbidden)) hits.push(`${rel}:${index+1}`);
    }
  }
}

walk(root);
if(hits.length){
  console.error('Retired product traces remain:');
  for(const hit of hits.slice(0,500)) console.error(`  ${hit}`);
  if(hits.length>500) console.error(`  ... ${hits.length-500} more`);
}
assert.deepStrictEqual(hits,[],'Retired product must have no source, route, UI, documentation, test, configuration, or migration traces');
console.log('retired product trace audit: ok');
