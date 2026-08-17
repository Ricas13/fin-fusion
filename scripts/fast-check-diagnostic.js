'use strict';

const fs=require('fs');
const cp=require('child_process');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const command=String(pkg.scripts?.['check:fast']||'');
const parts=command.split(/\s*&&\s*/).map(x=>x.trim()).filter(Boolean);
let failures=0;
for(const part of parts){
  process.stdout.write(`\n=== ${part} ===\n`);
  const result=cp.spawnSync(part,{shell:true,stdio:'inherit',env:process.env});
  if(result.status!==0){
    failures++;
    const safe=part.replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
    process.stdout.write(`::error file=package.json,title=Fast check failed::${safe}\n`);
  }
}
console.log(`Fast-check diagnostic complete; commands=${parts.length} failures=${failures}`);
if(failures)process.exitCode=1;
