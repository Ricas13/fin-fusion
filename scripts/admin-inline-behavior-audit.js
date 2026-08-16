'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.join(__dirname,'..');
const dir=path.join(root,'src','platform');

function files(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(entry=>{const full=path.join(d,entry.name);return entry.isDirectory()?files(full):entry.isFile()&&entry.name.endsWith('.js')?[full]:[];});}
function lineAt(text,index){let line=1;for(let i=0;i<index;i++)if(text.charCodeAt(i)===10)line++;return line;}

const findings=[];
for(const file of files(dir)){
  const text=fs.readFileSync(file,'utf8');
  if(!/require\(['"]\.\/admin-html['"]\)/.test(text)||!/\blayout\s*\(/.test(text))continue;
  const re=/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi;
  let match;
  while((match=re.exec(text)))findings.push(`${path.relative(root,file)}:${lineAt(text,match.index)}`);
}
if(findings.length){
  console.error('Admin modules still author inline scripts that admin-html strips before rendering:');
  for(const finding of findings)console.error(` - ${finding}`);
}
assert.equal(findings.length,0,'Admin interactions must be external same-origin JavaScript or server-rendered behavior, never silently stripped inline scripts');
console.log('admin inline behavior audit: ok');
