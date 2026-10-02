'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const retired=[
  'src/automation/job-metadata.js',
  'src/automation/critical-jobs.js'
];

for(const file of retired){
  assert(!fs.existsSync(path.join(root,file)),`retired automation compatibility module returned: ${file}`);
}

const roots=['src','scripts'];
const offenders=[];
function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())walk(full);
    else if(entry.isFile()&&entry.name.endsWith('.js')){
      const rel=path.relative(root,full).replace(/\\/g,'/');
      if(rel==='scripts/automation-registry-ownership-smoke.js')continue;
      const source=fs.readFileSync(full,'utf8');
      if(/require\(\s*['"][^'"]*(?:job-metadata|critical-jobs)['"]\s*\)/.test(source))offenders.push(rel);
    }
  }
}
for(const folder of roots)walk(path.join(root,folder));
assert.deepStrictEqual(offenders,[],'production/tests must not retain retired automation metadata/facade imports');

const registry=fs.readFileSync(path.join(root,'src','automation','jobs.js'),'utf8');
assert(registry.includes('const JOB_METADATA=Object.freeze({'),'executable job registry must own scheduling metadata');
for(const field of ['defaultIntervalSeconds','critical','disableableCritical']){
  assert(registry.includes(field),`canonical job registry must retain ${field} policy where applicable`);
}
assert(!registry.includes("require('./job-metadata')"),'canonical registry must not delegate metadata to a second table');

console.log('automation registry ownership smoke: ok');
