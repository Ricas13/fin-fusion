'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {esc,csrfHidden}=require('../src/platform/html-primitives');

const hostile='<script>alert("x")</script> & \'quoted\'';
const escaped=esc(hostile);
assert.strictEqual(
  escaped,
  '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;',
  'canonical HTML escaping must encode every HTML-significant character'
);
assert(!escaped.includes('<script>'),'escaped output must not retain executable markup');

const csrf=csrfHidden('"><img src=x onerror=alert(1)>');
assert.strictEqual(
  csrf,
  '<input type="hidden" name="_csrf" value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">',
  'CSRF hidden input must escape token values before interpolation'
);
assert(!csrf.includes('<img'),'CSRF token interpolation must never create markup');

const root=path.join(__dirname,'..');
const core=fs.readFileSync(path.join(root,'src/platform/admin-html-core-base.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'src/platform/admin-ui.js'),'utf8');
const wrapper=fs.readFileSync(path.join(root,'src/platform/customer-360-view.js'),'utf8');
const compact=fs.readFileSync(path.join(root,'src/platform/customer-360-compact.js'),'utf8');
const orders=fs.readFileSync(path.join(root,'src/platform/admin-orders.js'),'utf8');

assert(core.includes("require('./html-primitives')"),'admin HTML shell must consume canonical escaping');
assert(ui.includes("require('./html-primitives')"),'shared admin UI helpers must consume canonical escaping');
assert(wrapper.includes("require('./html-primitives')"),'Customer 360 wrapper must consume canonical HTML primitives');
assert(compact.includes("require('./html-primitives')"),'Customer 360 renderer must consume canonical HTML primitives');
assert(orders.includes("require('./html-primitives')")&&orders.includes('csrfHidden(csrf.token(req))'),
  'commerce orders must use the canonical escaped CSRF hidden-input primitive');

for(const [name,source] of [['core',core],['ui',ui],['wrapper',wrapper],['compact',compact]]){
  assert(!/function\s+(?:esc|escapeHtml|csrfHidden)\s*\(/.test(source),
    `${name} must not reintroduce a private HTML escape/CSRF primitive`);
}

console.log('HTML primitive safety smoke: ok');
