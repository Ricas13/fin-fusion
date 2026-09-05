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

// HTMLFormElement exposes named controls as properties. A control named
// "action" (the permanent-access form has one) must therefore never be allowed
// to replace the form action URL used by the shared AJAX enhancer.
const feedback=fs.readFileSync(path.join(root,'public/js/admin-form-feedback.js'),'utf8');
assert(feedback.includes("function formAttribute(form, name, fallback = '')"),'admin form feedback must resolve form metadata through literal attributes');
assert(feedback.includes("form.getAttribute(name)"),'admin form feedback must use getAttribute so named controls cannot shadow action/method/target/enctype/id');
assert(feedback.includes("formAttribute(form, 'action', window.location.href)"),'admin form action resolution must use the non-shadowable attribute helper');
assert(feedback.includes("formAttribute(form, 'method', 'POST')"),'admin form method resolution must use the non-shadowable attribute helper');
assert(feedback.includes("/^\\/admin\\/users\\/[0-9a-f-]{36}(?:\\/|$)/i.test(path)"),'Customer 360 mutations must remain native POST/redirect/GET workflows rather than generic AJAX submissions');
assert(!/return\s+override\s*\?[^;]*:\s*\(form\.action\b/.test(feedback),'form.action must not be used as an enhanced-submit target because a named action control can shadow it');
assert(!/String\(override\s*\|\|\s*form\.method\b/.test(feedback),'form.method must not be read directly by the enhancer');

// The modern Customer 360 hero is the owner of "View User Page". The legacy
// customer tab bar is hidden, so deferred enhancement must never move the
// impersonation form into it after first paint.
const customerOperator=fs.readFileSync(path.join(root,'public/js/admin-customer-operator.js'),'utf8');
assert(customerOperator.includes('.customerMockTopActions form[action='),'Customer 360 enhancement must target the visible hero portal action');
assert(customerOperator.includes("heroForm.dataset.nativeSubmit='true'"),'View User Page must remain a native POST/redirect flow');
assert(customerOperator.includes("button.textContent='View User Page ↗'"),'Customer 360 must keep the requested View User Page label after enhancement');
assert(!customerOperator.includes('nav.appendChild(wrapper)'),'Customer 360 must never relocate the portal form into the hidden legacy navigation');

console.log('admin inline behavior audit: ok');
