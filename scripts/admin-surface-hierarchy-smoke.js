'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const script = read('public/js/admin-surface-semantics.js');
const css = read('public/css/admin-surface-semantics.css');
const density = read('public/css/admin-card-density.css');
const capability = read('public/css/admin-capability.css');
const htmlCore = read('src/platform/admin-html-core.js');
const legacyHead = read('views/admin/_head.ejs');

assert(capability.includes("@import url('/css/admin-surface-semantics.css')"), 'shared capability CSS must load the semantic surface layer');
assert(capability.includes("@import url('/css/admin-card-density.css')"), 'shared capability CSS must load the global card density layer after component styles');
assert(htmlCore.includes('/js/admin-surface-semantics.js'), 'HTML admin shell must load the semantic classifier');
assert(legacyHead.includes('/js/admin-surface-semantics.js'), 'legacy EJS admin shell must load the semantic classifier');

assert(script.includes("'control' : 'data'"), 'table surfaces must resolve to control or data semantics');
assert(script.includes('table.querySelector(MUTABLE_TABLE_CONTROL)'), 'configuration classification must be based on controls inside tables');
assert(script.includes('input:not([type="hidden"])') && script.includes('select:not([disabled])') && script.includes('[role="switch"]'), 'real mutable controls must identify configuration tables');
assert(script.includes(':not([type="checkbox"])') && script.includes('.inlineToggle input[type="checkbox"]'), 'generic row-selection checkboxes must stay data semantics while setting toggles remain configuration');
assert(!script.includes("'button[type=\"submit\"]'") && !script.includes("'button[type=submit]'"), 'action buttons alone must not make a data table look configurable');
assert(!script.includes("a.button") && !script.includes("a[href"), 'navigation links alone must not make a read-only table look configurable');
assert(script.includes('classifyStandaloneControls') && script.includes('MUTABLE_SETTING_CONTROL'), 'empty configurable sections must still be recognised from their genuine setting fields');
assert(script.includes('data.adminSurface') || script.includes('dataset.adminSurface'), 'explicit per-surface overrides must remain available');
assert(script.includes('MutationObserver'), 'dynamically rendered tables must receive the same semantic treatment');

assert(css.includes('.adminSurface--control') && css.includes('.adminSurface--data'), 'control and read-only surfaces need distinct visual contracts');
assert(css.includes('Configuration') || script.includes("'Configuration'"), 'editable surfaces must carry a visible configuration cue');
assert(css.includes('Read only') || script.includes("'Read only'"), 'read-only surfaces must carry a visible inspection cue');
assert(css.includes('.adminSurface--data table td') && css.includes('padding:8px 11px'), 'read-only tables should be denser than normal tables');
assert(css.includes('.adminSurface--control table td') && css.includes('padding:10px 11px'), 'editable tables must retain room for controls');
assert(css.includes('.adminOverviewSurface'), 'overview surfaces must have a compact, subordinate visual treatment');
assert(css.includes('.notice:not(.error):not(.warn)') && css.includes('.uiSectionHeader') && css.includes('.statusBanner'), 'non-actionable information chrome should be compressed');
assert(css.includes('.capabilitySummary.adminOverviewSurface .capabilityStat'), 'overview KPI internals should also be compacted');

assert(density.includes('grid-template-columns:repeat(6,minmax(0,1fr))'), 'card density must use the shared six-column foundation');
assert(density.includes('[data-card-density="3"]') && density.includes('grid-column:span 2'), 'three-up cards must occupy two of six columns');
assert(density.includes('[data-card-density="2"]') && density.includes('grid-column:span 3'), 'two-up cards must occupy three of six columns');
assert(density.includes('[data-card-density="1"]') && density.includes('grid-column:1/-1'), 'one-up cards must be explicit full-width exceptions');
assert(density.includes('.settings-grid:has(>:nth-child(2):last-child)>*') && density.includes('.settings-grid:has(>:nth-child(4):last-child)>*'), 'shared settings grids must balance two-card and four-card pages instead of leaving dead columns');
assert(density.includes('.serverGrid:has(>:nth-child(2):last-child)>*') && density.includes('.serverGrid:has(>:nth-child(4):last-child)>*'), 'shared server/customer card grids must use the same balanced 3/2/1 density contract');
assert(density.includes(':has(.dataTable,.tableWrap,.booleanMatrix,.capabilityLibraryGrid)') && density.includes('grid-column:1/-1!important'), 'wide table and matrix cards must escape to one-up density automatically');
assert(density.includes('.planControlGrid>#product') && density.includes('.planControlGrid>#requests') && density.includes('grid-column:span 3!important'), 'medium Jellyfin plan editors must use two-up density');
assert(density.includes('.planControlGrid>#availability') && density.includes('.planControlGrid>#delivery') && density.includes('.planControlGrid>#libraries'), 'compact Jellyfin plan editors must use three-up density');
assert(density.includes('.notificationIdentityGrid') && density.includes('repeat(3,minmax(0,1fr))'), 'short personal settings cards must cap at three across');
assert(density.includes('.capabilityControlGrid') && density.includes('.analyticsGrid'), 'complex capability and analytics surfaces must remain explicit wide/2-up exceptions');
assert(density.includes('align-items:start!important') && density.includes('height:auto'), 'short cards must not stretch to match taller neighbours');
assert(density.includes('@media(max-width:1180px)') && density.includes('@media(max-width:720px)'), 'card density must collapse safely for tablet and mobile widths');

console.log('admin semantic surface hierarchy checks passed.');
