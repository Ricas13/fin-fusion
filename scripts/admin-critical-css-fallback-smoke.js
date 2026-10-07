'use strict';

const fs=require('fs');
const assert=require('assert');
const core=require('../src/platform/admin-html-core-base');

const REQUIRED=[
  '--enclosure:#151A1E',
  '--rail:#101417',
  '--line:#262D34',
  '--text:#E4E9ED',
  '--dim:#8794A0',
  '--pitch:40px',
  '--gut:16px',
  '--r:8px',
  '--rail-w:240px',
  '--bar-h:56px'
];

function stripExternalStyles(html){
  return String(html).replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi,'');
}

function assertCriticalTokens(label,html){
  for(const token of REQUIRED)assert(html.includes(token),`${label} critical CSS is missing ${token}`);
  assert(html.includes('@media(max-width:820px){:root{--pitch:44px;--bar-h:52px;--rail-w:0px}}'),`${label} is missing mobile token fallbacks`);
  assert(html.includes('.adminHeader{position:fixed'),`${label} is missing critical sidebar geometry`);
  assert(/\.mainPane(?:,\.adminMain)?\{min-width:0;min-height:100vh;margin-left:var\(--rail-w\)/.test(html),`${label} is missing critical main-pane geometry`);
}

const rendered=core.layout({title:'Critical CSS test',active:'dashboard',body:'<p>ok</p>'});
const withoutStylesheets=stripExternalStyles(rendered);
assertCriticalTokens('string-rendered admin shell',withoutStylesheets);

const ejsHead=fs.readFileSync(require('path').join(__dirname,'..','views','admin','_head.ejs'),'utf8');
assertCriticalTokens('legacy EJS admin shell',ejsHead);

console.log('admin critical css fallback smoke: ok');
