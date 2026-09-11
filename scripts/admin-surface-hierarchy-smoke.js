'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

const core=read('src/platform/admin-html-core-base.js');
const density=read('public/css/admin-card-density.css');
const planControl=read('public/css/admin-plan-control.css');
const operations=read('public/css/admin-operations-layout.css');

// Semantic page shell: hierarchy should come from shared page-level primitives,
// not one-off route styling that gradually diverges.
assert(core.includes('.pageHeader')&&core.includes('.pageTitle')&&core.includes('.pageSubtitle'),'shared admin page hierarchy primitives missing');
assert(core.includes('.sectionHead')&&core.includes('.sectionTitle'),'shared admin section hierarchy primitives missing');
assert(core.includes('.metricLabel')&&core.includes('.metricValue'),'shared metric hierarchy primitives missing');
assert(core.includes('.formGroup>label'),'shared form label hierarchy missing');
assert(core.includes('.muted'),'shared muted/supporting text primitive missing');

// Titles and headings need a deliberate type scale rather than browser defaults.
assert(/\.pageTitle\{[^}]*font-size:clamp\(/.test(core),'page title must use the shared responsive type scale');
assert(/\.sectionTitle\{[^}]*font-size:/.test(core),'section titles must have an explicit shared size');
assert(/\.sectionHead h2[^}]*font-size:/.test(core),'legacy section headings must inherit an explicit shared size');
assert(/\.sectionHead h3[^}]*font-size:/.test(core),'legacy subsection headings must inherit an explicit shared size');
assert(/\.formGroup>label\{[^}]*font-size:/.test(core),'form labels must have an explicit shared size');
assert(/\.metricLabel\{[^}]*text-transform:uppercase/.test(core),'metric labels must read as secondary metadata');
assert(/\.metricValue\{[^}]*font-size:/.test(core),'metric values must remain visually primary');
assert(core.includes('.pageHeader{display:flex')&&core.includes('align-items:flex-start'),'page header must allow title/subtitle/action hierarchy without vertical centering distortion');

// Generic card density: six logical columns give deterministic 3-up/2-up/1-up
// layouts without every route inventing its own widths.
assert(density.includes('.settings-grid,.serverGrid')&&density.includes('repeat(6,minmax(0,1fr))'),'shared settings/server grids must use the six-column density system');
assert(density.includes('[data-card-density="3"]') && density.includes('grid-column:span 2'), 'three-up cards must occupy two of six columns');
assert(density.includes('[data-card-density="2"]') && density.includes('grid-column:span 3'), 'two-up cards must occupy three of six columns');
assert(density.includes('[data-card-density="1"]') && density.includes('grid-column:1/-1'), 'one-up cards must be explicit full-width exceptions');
assert(density.includes('.settings-grid:has(>:nth-child(2):last-child)>*') && density.includes('.settings-grid:has(>:nth-child(4):last-child)>*'), 'shared settings grids must balance two-card and four-card pages instead of leaving dead columns');
assert(density.includes('.serverGrid:has(>:nth-child(2):last-child)>*') && density.includes('.serverGrid:has(>:nth-child(4):last-child)>*'), 'shared server/customer card grids must use the same balanced 3/2/1 density contract');
assert(density.includes(':has(.dataTable,.tableWrap,.booleanMatrix,.capabilityLibraryGrid)') && density.includes('grid-column:1/-1!important'), 'wide table and matrix cards must escape to one-up density automatically');
assert(!density.includes('.planControlGrid{')&&!density.includes('.planControlGrid>'), 'global card density must not override plan editor geometry or recreate plan mosaics');
assert(planControl.includes('.planControlGrid{display:grid;grid-template-columns:1fr!important')&&planControl.includes('@media(min-width:820px)')&&planControl.includes('repeat(2,minmax(0,1fr))')&&planControl.includes('@media(min-width:1280px)')&&planControl.includes('repeat(3,minmax(0,1fr))'), 'plan control room must own the responsive one/two/three-column editor layout');
assert(planControl.includes('.planConfigCard.span2,.planConfigCard.span3{grid-column:auto!important}')&&planControl.includes('.planControlGrid>.requestPlanCard{grid-column:auto!important'), 'plan control room must let legacy spans and request policy participate in the compact grid');
assert(density.includes('.notificationIdentityGrid') && density.includes('repeat(3,minmax(0,1fr))'), 'short personal settings cards must cap at three across');
assert(density.includes('.capabilityControlGrid') && density.includes('.analyticsGrid'), 'complex capability and analytics surfaces must remain explicit wide/2-up exceptions');
assert(density.includes('align-items:start!important') && density.includes('height:auto'), 'short cards must not stretch to match taller neighbours');
assert(density.includes('@media(max-width:1180px)') && density.includes('@media(max-width:720px)'), 'card density must collapse safely for tablet and mobile widths');

assert(operations.includes('.topBar')&&operations.includes('position:relative!important'),'admin top bar must stay in document flow rather than overlay page titles and controls');
assert(operations.includes('.page-automation .automationGroup .serverGrid')&&operations.includes('grid-template-columns:repeat(3,minmax(0,1fr))!important')&&operations.includes('.page-automation .serverGrid>.automationJobCard')&&operations.includes('grid-column:auto!important'),'automation configuration cards must use the Automation page three-up desktop layout owned by the final operations stylesheet');
assert(operations.includes('.automationJobCard .kvList')&&operations.includes('grid-template-columns:repeat(2,minmax(0,1fr))'),'automation metadata must compact into a readable two-column grid');
assert(operations.includes('.operatorDetailsBody>.section:only-child')&&operations.includes('980px'),'single expanded settings editors must not stretch into empty full-width canvases');
assert(operations.includes('.ordersTable')&&operations.includes('.provisioningTable'),'problematic operational tables must have explicit responsive sizing contracts');

console.log('admin semantic surface hierarchy checks passed.');
