'use strict';

const fs=require('fs');
const cp=require('child_process');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const command=String(pkg.scripts?.['check:fast']||'');
const parts=command.split(/\s*&&\s*/).map(x=>x.trim()).filter(Boolean);
let failures=0;
function escape(value){return String(value||'').replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');}
for(const part of parts){
  process.stdout.write(`\n=== ${part} ===\n`);
  const result=cp.spawnSync(part,{shell:true,encoding:'utf8',env:process.env});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.status!==0){
    failures++;
    const detail=`${result.stderr||''}\n${result.stdout||''}`.trim().slice(-1200);
    process.stdout.write(`::error file=package.json,title=Fast check failed - ${escape(part)}::${escape(detail||part)}\n`);
  }
}
console.log(`Fast-check diagnostic complete; commands=${parts.length} failures=${failures}`);
if(failures)process.exitCode=1;
