'use strict';

const fs=require('fs');
const path=require('path');
const cp=require('child_process');

const CANONICAL='CAPTAiNFiN';
const WORD=/\bcaptainfin\b/gi;
const WRITE=process.argv.includes('--write');
const BINARY_EXTENSIONS=new Set(['.png','.jpg','.jpeg','.gif','.webp','.ico','.pdf','.zip','.gz','.tgz','.woff','.woff2','.ttf','.eot','.mp4','.mkv','.sqlite','.db']);
function trackedFiles(){return cp.execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);}
function shouldRead(file){return!BINARY_EXTENSIONS.has(path.extname(file).toLowerCase());}
function replacements(text){let changed=false;const value=text.replace(WORD,match=>{if(match==='captainfin'||match===CANONICAL)return match;changed=true;return CANONICAL;});return{value,changed};}
const offenders=[];
for(const file of trackedFiles()){
  if(!shouldRead(file)||!fs.existsSync(file))continue;
  let text;try{text=fs.readFileSync(file,'utf8');}catch{continue;}
  const result=replacements(text);if(!result.changed)continue;
  if(WRITE){fs.writeFileSync(file,result.value,'utf8');continue;}
  const lines=text.split(/\r?\n/);for(let i=0;i<lines.length;i++){const matches=lines[i].match(WORD)||[];for(const match of matches){if(match!=='captainfin'&&match!==CANONICAL)offenders.push(`${file}:${i+1}: ${match}`);}}
}
if(WRITE){console.log('CAPTAiNFiN brand normalization complete');process.exit(0);}
if(offenders.length){console.error(`Non-canonical CAPTAiNFiN branding found (${offenders.length}):`);for(const item of offenders)console.error(` - ${item}`);process.exit(1);}
console.log('CAPTAiNFiN brand audit: ok');
