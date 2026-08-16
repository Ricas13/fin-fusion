'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const html=read('src/platform/admin-html.js');
const core=read('src/platform/admin-html-core.js');
const baseCss=read('public/css/admin-original-base.css');
const componentCss=read('public/css/admin-original-components.css');
const refinementCss=read('public/css/admin-visual-refinement.css');
const plans=read('src/platform/admin-plans-list.js');

assert(html.includes('decorateSettingHelp'),'Shared admin renderer must decorate settings with helper descriptions');
assert(html.includes('SETTING_HELP'),'Shared setting-help registry must exist');
assert(core.includes('topBreadcrumb'),'Admin shell must render a stable top breadcrumb');
assert(core.includes('<details class="navSection'),'Admin navigation groups must be collapsible');
assert(core.includes("${activeGroup?'open':''}"),'The active navigation group must start expanded');
assert(core.includes('/css/admin-visual-refinement.css'),'Admin shell must load the visual refinement layer');
assert(baseCss.includes('--sidebar-w:248px'),'Desktop admin shell should use the wider visual-hierarchy sidebar');
assert(componentCss.includes('.fieldHelp'),'Admin controls must have a consistent helper-description style');
assert(componentCss.includes('min-height:40px'),'Admin controls must use the larger readable control size');
assert(refinementCss.includes('.navSection[open] .navSectionPages'),'Accordion CSS must expose only expanded navigation groups on desktop');
assert(refinementCss.includes('.settings-grid{grid-template-columns:repeat(2,minmax(0,1fr))'),'Settings must use broad two-column cards on large screens');
assert(refinementCss.includes('.formGrid{grid-template-columns:repeat(3,minmax(0,1fr))'),'Wide forms must be capped at three columns');
assert(refinementCss.includes('.planListToolbar{display:grid'),'Plan filters must render as a compact toolbar');
assert(refinementCss.includes('.planListFilteredEmpty{display:none'),'Filtered-empty feedback must be hidden while plans are visible');
assert(refinementCss.includes('.chartEmpty{height:108px}'),'Empty dashboard charts must not dominate vertical space');
assert(plans.includes('data-plan-table-wrap'),'Plan filtering must be able to hide the table when no rows match');

console.log('admin UX foundation smoke: ok');
