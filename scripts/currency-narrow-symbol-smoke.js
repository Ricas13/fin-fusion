'use strict';

const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const roots=['src','views','public'];
const extensions=new Set(['.js','.cjs','.mjs','.ejs']);
const failures=[];

function files(dir){
  if(!fs.existsSync(dir))return[];
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='node_modules'||entry.name.startsWith('.'))continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...files(full));
    else if(extensions.has(path.extname(entry.name)))out.push(full);
  }
  return out;
}

for(const base of roots){
  for(const file of files(path.join(root,base))){
    const source=fs.readFileSync(file,'utf8');
    let from=0;
    while(true){
      const index=source.indexOf('new Intl.NumberFormat',from);
      if(index<0)break;
      const formatEnd=source.indexOf('.format',index);
      const end=formatEnd>=0&&formatEnd-index<1500?formatEnd:Math.min(source.length,index+1500);
      const snippet=source.slice(index,end);
      if(/style\s*:\s*['"]currency['"]/.test(snippet)&&!/currencyDisplay\s*:\s*['"]narrowSymbol['"]/.test(snippet)){
        const line=source.slice(0,index).split('\n').length;
        failures.push(`${path.relative(root,file)}:${line}`);
      }
      from=index+'new Intl.NumberFormat'.length;
    }
  }
}

if(failures.length){
  console.error('Currency formatters missing currencyDisplay: narrowSymbol:');
  for(const failure of failures)console.error(` - ${failure}`);
  process.exit(1);
}
console.log('currency narrow-symbol smoke: ok');
