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

const globalForm=fs.readFileSync(path.join(root,'public/js/admin-form-feedback.js'),'utf8');
const brandingScript=fs.readFileSync(path.join(root,'public/js/admin-branding.js'),'utf8');
const customerBulk=fs.readFileSync(path.join(root,'public/js/admin-customers-bulk.js'),'utf8');
const adminHtml=fs.readFileSync(path.join(root,'src/platform/admin-html.js'),'utf8');
const brandingPage=fs.readFileSync(path.join(root,'src/platform/admin-branding.js'),'utf8');
const customerList=fs.readFileSync(path.join(root,'src/platform/admin-customers-list.js'),'utf8');

assert(!globalForm.includes('uploadBrandAsset'),'Global form controller must not own branding binary uploads');
assert(!globalForm.includes('data-brand-upload'),'Global form controller must not bind branding-only controls');
assert(!globalForm.includes("getElementById('checkAllPage')"),'Global form controller must not duplicate customer bulk select-all behavior');
assert(globalForm.includes('appendBulkSelections'),'Global form submission must still serialize externally-associated selected customer rows');
assert(globalForm.includes('data-copy-link'),'Global copy-link behavior must remain available to admin pages');
assert(globalForm.includes('confirmSubmit'),'Global destructive-form confirmation must remain available');

assert(brandingScript.includes('data-brand-upload'),'Branding page controller must own branding upload controls');
assert(brandingScript.includes('/admin/settings/branding/'),'Branding page controller must post to the branding upload endpoint');
assert(brandingScript.includes("'X-CSRF-Token'"),'Branding binary upload must retain CSRF header protection');
assert(adminHtml.includes("function brandingScriptFor"),'Admin layout wrapper must expose branding page asset selection');
assert(adminHtml.includes('/js/admin-branding.js'),'Branding page must load its dedicated browser controller');
assert(brandingPage.includes("active: 'branding'"),'Branding route must select the branding page asset key');

assert(customerBulk.includes("getElementById('checkAllPage')"),'Customer bulk controller must remain the select-all owner');
assert(customerBulk.includes('indeterminate'),'Customer bulk controller must retain partial-selection state');
assert(customerList.includes('/js/admin-customers-bulk.js'),'Customer list must load its dedicated bulk controller');

console.log('admin inline/browser behavior audit: ok');
