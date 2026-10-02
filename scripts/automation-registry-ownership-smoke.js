'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
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
      if(/require\(\s*['"][^'"]*(?:job-metadata|critical-jobs)['"]\s*\)/.test(source)
        && !['src/automation/job-metadata.js','src/automation/critical-jobs.js'].includes(rel))offenders.push(rel);
    }
  }
}
for(const folder of roots)walk(path.join(root,folder));
assert.deepStrictEqual(offenders,[],'production/tests must consume the canonical jobs registry rather than compatibility facades');
const metadataFacade=fs.readFileSync(path.join(root,'src','automation','job-metadata.js'),'utf8');
const criticalFacade=fs.readFileSync(path.join(root,'src','automation','critical-jobs.js'),'utf8');
assert(metadataFacade.includes("require('./jobs')")&&!metadataFacade.includes('health: { defaultIntervalSeconds'),
  'job-metadata compatibility must delegate to jobs.js without recreating scheduling truth');
assert(criticalFacade.includes("require('./jobs')")&&!criticalFacade.includes("require('./job-metadata')"),
  'critical-jobs compatibility must delegate directly to jobs.js');

const registry=fs.readFileSync(path.join(root,'src','automation','jobs.js'),'utf8');
assert(registry.includes('const JOB_METADATA=Object.freeze({'),'executable job registry must own scheduling metadata');
for(const field of ['defaultIntervalSeconds','critical','disableableCritical']){
  assert(registry.includes(field),`canonical job registry must retain ${field} policy where applicable`);
}
assert(!registry.includes("require('./job-metadata')"),'canonical registry must not delegate metadata to a second table');

console.log('automation registry ownership smoke: ok');
