'use strict';

const fs=require('fs');
const path=require('path');

function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const full=path.join(dir,entry.name);return entry.isDirectory()?files(full):[full];});}

const findings=[];
for(const file of files(path.join(__dirname,'..','views')).filter(name=>name.endsWith('.ejs'))){
    const text=fs.readFileSync(file,'utf8'),lines=text.split(/\r?\n/);
    lines.forEach((line,index)=>{
        if(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(line))findings.push(`${path.relative(process.cwd(),file)}:${index+1}: inline <script>`);
        if(/\son[a-z]+\s*=\s*["']/i.test(line))findings.push(`${path.relative(process.cwd(),file)}:${index+1}: inline event handler`);
        if(/javascript\s*:/i.test(line))findings.push(`${path.relative(process.cwd(),file)}:${index+1}: javascript: URL`);
    });
}
if(findings.length){
    console.error('Inline JavaScript prevents removing CSP script-src unsafe-inline:');
    for(const finding of findings)console.error(` - ${finding}`);
    process.exit(1);
}
console.log('CSP inline-JavaScript audit passed.');
