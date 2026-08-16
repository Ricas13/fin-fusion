'use strict';

const fs=require('fs');
const path=require('path');

function files(dir){return fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const full=path.join(dir,entry.name);return entry.isDirectory()?files(full):[full];}):[];}
function lineAt(text,index){let line=1;for(let i=0;i<index;i++)if(text.charCodeAt(i)===10)line++;return line;}
function matches(text,re){const out=[];re.lastIndex=0;let match;while((match=re.exec(text))){out.push({index:match.index,value:match[0]});if(match[0].length===0)re.lastIndex++;}return out;}

const root=path.join(__dirname,'..');
const adminHtmlPath=path.join(root,'src','platform','admin-html.js');
const adminHtml=fs.readFileSync(adminHtmlPath,'utf8');
const directSanitizedRender=/body\s*:\s*stripInlineScripts\s*\(\s*options\.body\s*\)/.test(adminHtml);
const decoratedSanitizedRender=/const\s+safeBody\s*=\s*stripInlineScripts\s*\(\s*options\.body\s*\)\s*;[\s\S]*body\s*:\s*decorateSettingHelp\s*\(\s*safeBody\s*\)/.test(adminHtml)
    && /function\s+decorateSettingHelp\s*\(/.test(adminHtml)
    && /core\.esc\s*\(\s*help\s*\)/.test(adminHtml);
const sanitizerPresent=/function\s+stripInlineScripts\s*\(/.test(adminHtml)
    && /indexOf\(\s*['"]<script['"]/.test(adminHtml)
    && /function\s+externalScriptTag\s*\(/.test(adminHtml)
    && (directSanitizedRender||decoratedSanitizedRender)
    && /module\.exports\s*=\s*\{[\s\S]*stripInlineScripts/.test(adminHtml)
    && !/stripInlineScripts[\s\S]*?\.replace\(\s*\/<script/i.test(adminHtml);

const targets=[
    ...files(path.join(root,'views')).filter(name=>name.endsWith('.ejs')),
    ...files(path.join(root,'src')).filter(name=>name.endsWith('.js'))
];
const findings=[];
if(!sanitizerPresent)findings.push('src/platform/admin-html.js: admin layout no longer proves deterministic inline-script stripping before render');

for(const file of targets){
    const text=fs.readFileSync(file,'utf8');
    const isSanitizerFile=path.resolve(file)===path.resolve(adminHtmlPath);
    const usesSanitizedAdminLayout=sanitizerPresent
        && /require\(['"]\.\/admin-html['"]\)/.test(text)
        && /\blayout\s*\(/.test(text);
    // Scan the complete source, not individual lines. HTML attributes and
    // <script> tags can legally span line breaks; a line-oriented regex left a
    // blind spot in the CI gate even though the runtime CSP itself was sound.
    if(!isSanitizerFile&&!usesSanitizedAdminLayout){
        for(const hit of matches(text,/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi))findings.push(`${path.relative(root,file)}:${lineAt(text,hit.index)}: inline <script>`);
    }
    for(const hit of matches(text,/\son[a-z]+\s*=\s*["']/gi))findings.push(`${path.relative(root,file)}:${lineAt(text,hit.index)}: inline event handler`);
    for(const hit of matches(text,/javascript\s*:/gi))findings.push(`${path.relative(root,file)}:${lineAt(text,hit.index)}: javascript: URL`);
}
if(findings.length){
    console.error('Inline JavaScript prevents removing CSP script-src unsafe-inline:');
    for(const finding of findings)console.error(` - ${finding}`);
    process.exit(1);
}
console.log(`CSP inline-JavaScript audit passed across ${targets.length} rendered-source files (multiline-aware).`);