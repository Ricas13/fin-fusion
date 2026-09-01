'use strict';

const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const roots=['src','views','public'];
const extensions=new Set(['.js','.cjs','.mjs','.ejs']);
const failures=[];
const auditCandidates=[];

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

function humanFacing(relative){
  return relative.startsWith('views/')||relative.startsWith('public/')||relative.startsWith('src/platform/')||relative.startsWith('src/integrations/')||relative.startsWith('src/automation/');
}

function manualCurrencyDisplay(line){
  const currency='(?:currency|currencyCode|currency_code|USD|GBP|EUR)';
  const money='(?:amount|price|total|cost|revenue|profit|spend|fee|refund|balance|minor|value)';
  const withoutCanonicalFormatters=line.replace(/\b(?:moneyFormat\.(?:formatMinor|formatMajor)|money)\([^)]*\)/g,'');
  return new RegExp(`(?:\\$\\{[^}]*${currency}[^}]*\\}\\s*\\$\\{[^}]*${money}[^}]*\\}|\\$\\{[^}]*${money}[^}]*\\}\\s*\\$\\{[^}]*${currency}[^}]*\\}|(?:USD|GBP|EUR)\\s*(?:\\$\\{|\\+)\\s*[^;]*|(?:currency|currencyCode|currency_code)\\s*\\+\\s*[^;]*${money}|${money}[^;]*\\+\\s*(?:currency|currencyCode|currency_code))`,'i').test(withoutCanonicalFormatters);
}

for(const base of roots){
  for(const file of files(path.join(root,base))){
    const source=fs.readFileSync(file,'utf8');
    const relative=path.relative(root,file).replace(/\\/g,'/');
    let from=0;
    while(true){
      const index=source.indexOf('new Intl.NumberFormat',from);
      if(index<0)break;
      const formatEnd=source.indexOf('.format',index);
      const end=formatEnd>=0&&formatEnd-index<1500?formatEnd:Math.min(source.length,index+1500);
      const snippet=source.slice(index,end);
      if(/style\s*:\s*['"]currency['"]/.test(snippet)&&!/currencyDisplay\s*:\s*['"]narrowSymbol['"]/.test(snippet)){
        const line=source.slice(0,index).split('\n').length;
        failures.push(`${relative}:${line}`);
      }
      from=index+'new Intl.NumberFormat'.length;
    }
    if(!humanFacing(relative))continue;
    source.split(/\r?\n/).forEach((line,index)=>{
      if(manualCurrencyDisplay(line))auditCandidates.push(`${relative}:${index+1}: ${line.trim().slice(0,500)}`);
    });
  }
}

if(auditCandidates.length){
  console.error('Manual human-facing currency display audit candidates:');
  for(const candidate of auditCandidates)console.error(` - ${candidate}`);
  console.error('Replace visible ISO-code concatenation with the canonical symbol-aware money formatter, or narrow this audit only when the line is demonstrably non-display technical state.');
  process.exit(1);
}
if(failures.length){
  console.error('Currency formatters missing currencyDisplay: narrowSymbol:');
  for(const failure of failures)console.error(` - ${failure}`);
  process.exit(1);
}
console.log('currency narrow-symbol smoke: ok');
