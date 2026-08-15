'use strict';

const fs=require('fs');
const path=require('path');

function files(dir){return fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const full=path.join(dir,entry.name);return entry.isDirectory()?files(full):[full];}):[];}

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
    const text=fs.readFileSync(file,'utf8'),lines=text.split(/\r?\n/);
    const isSanitizerFile=path.resolve(file)===path.resolve(adminHtmlPath);
    const usesSanitizedAdminLayout=sanitizerPresent
        && /require\(['"]\.\/admin-html['"]\)/.test(text)
        && /\blayout\s*\(/.test(text);
    lines.forEach((line,index)=>{
        // Legacy admin fragments are safe only because admin-html strips inline
        // script blocks before they reach the response. Public/custom shells do
        // not receive that exception and must use external scripts directly.
        // The sanitizer source itself contains the literal "<script" as scanner
        // input and is therefore excluded from rendered-source findings.
        if(!isSanitizerFile&&/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(line)&&!usesSanitizedAdminLayout)findings.push(`${path.relative(root,file)}:${index+1}: inline <script>`);
        if(/\son[a-z]+\s*=\s*["']/i.test(line))findings.push(`${path.relative(root,file)}:${index+1}: inline event handler`);
        if(/javascript\s*:/i.test(line))findings.push(`${path.relative(root,file)}:${index+1}: javascript: URL`);
    });
}
if(findings.length){
    console.error('Inline JavaScript prevents removing CSP script-src unsafe-inline:');
    for(const finding of findings)console.error(` - ${finding}`);
    process.exit(1);
}
console.log(`CSP inline-JavaScript audit passed across ${targets.length} rendered-source files.`);
