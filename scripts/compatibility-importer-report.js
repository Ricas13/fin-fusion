'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');

function walk(dir){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...walk(full));
    else if(entry.isFile()&&entry.name.endsWith('.js'))out.push(full);
  }
  return out;
}

function rel(file){return path.relative(root,file).replace(/\\/g,'/');}
function source(file){return fs.readFileSync(file,'utf8');}

const srcFiles=walk(path.join(root,'src'));
const facades=srcFiles.filter(file=>source(file).includes('@compatibility-facade'));
const report=[];

for(const facade of facades){
  const facadeRel=rel(facade);
  const facadeNoExt=facadeRel.replace(/\.js$/,'');
  const facadeDir=path.dirname(facadeRel);
  const base=path.basename(facadeNoExt);
  const importers=[];

  for(const file of srcFiles){
    if(file===facade)continue;
    const fileRel=rel(file);
    const text=source(file);
    const requireRe=/require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while((match=requireRe.exec(text))){
      const spec=match[1];
      if(!spec.startsWith('.'))continue;
      const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(fileRel),spec)).replace(/\.js$/,'');
      if(resolved===facadeNoExt){
        importers.push(fileRel);
        break;
      }
    }
  }

  report.push({facade:facadeRel,productionImporters:[...new Set(importers)].sort()});
}

let violations=0;
for(const row of report){
  console.log(`${row.facade}: ${row.productionImporters.length} production importer(s)`);
  for(const importer of row.productionImporters)console.log(`  - ${importer}`);
  if(row.productionImporters.length){
    violations+=row.productionImporters.length;
    console.error(`Compatibility facade ${row.facade} must not gain production callers; import the canonical owner directly.`);
  }
}

if(!report.length)console.log('No compatibility facades marked in src/.');
console.log(JSON.stringify({facades:report},null,2));
if(violations)process.exitCode=1;
