'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const html=fs.readFileSync(path.join(__dirname,'..','src','platform','admin-html.js'),'utf8');
const core=fs.readFileSync(path.join(__dirname,'..','src','platform','admin-html-core.js'),'utf8');
const baseCss=fs.readFileSync(path.join(__dirname,'..','public','css','admin-original-base.css'),'utf8');
const componentCss=fs.readFileSync(path.join(__dirname,'..','public','css','admin-original-components.css'),'utf8');

assert(html.includes('decorateSettingHelp'),'Shared admin renderer must decorate settings with helper descriptions');
assert(html.includes('SETTING_HELP'),'Shared setting-help registry must exist');
assert(core.includes('navSectionLabel'),'Admin shell must render explicit navigation section labels');
assert(core.includes('topBreadcrumb'),'Admin shell must render a stable top breadcrumb');
assert(baseCss.includes('--sidebar-w:248px'),'Desktop admin shell should use the wider visual-hierarchy sidebar');
assert(baseCss.includes('.navSectionLabel'),'Admin CSS must style navigation section labels');
assert(componentCss.includes('.fieldHelp'),'Admin controls must have a consistent helper-description style');
assert(componentCss.includes('min-height:40px'),'Admin controls must use the larger readable control size');

console.log('admin UX foundation smoke: ok');
