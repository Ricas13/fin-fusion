'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const script = read('public/js/admin-surface-semantics.js');
const css = read('public/css/admin-surface-semantics.css');
const capability = read('public/css/admin-capability.css');
const htmlCore = read('src/platform/admin-html-core.js');
const legacyHead = read('views/admin/_head.ejs');

assert(capability.includes("@import url('/css/admin-surface-semantics.css')"), 'shared capability CSS must load the semantic surface layer');
assert(htmlCore.includes('/js/admin-surface-semantics.js'), 'HTML admin shell must load the semantic classifier');
assert(legacyHead.includes('/js/admin-surface-semantics.js'), 'legacy EJS admin shell must load the semantic classifier');

assert(script.includes("'control' : 'data'"), 'table surfaces must resolve to control or data semantics');
assert(script.includes('table.querySelector(MUTABLE_TABLE_CONTROL)'), 'configuration classification must be based on controls inside tables');
assert(script.includes('input:not([type="hidden"])') && script.includes('select:not([disabled])') && script.includes('[role="switch"]'), 'real mutable controls must identify configuration tables');
assert(!script.includes("a.button") && !script.includes("a[href"), 'navigation links alone must not make a read-only table look configurable');
assert(script.includes('data.adminSurface') || script.includes('dataset.adminSurface'), 'explicit per-surface overrides must remain available');
assert(script.includes('MutationObserver'), 'dynamically rendered tables must receive the same semantic treatment');

assert(css.includes('.adminSurface--control') && css.includes('.adminSurface--data'), 'control and read-only surfaces need distinct visual contracts');
assert(css.includes('Configuration') || script.includes("'Configuration'"), 'editable surfaces must carry a visible configuration cue');
assert(css.includes('Read only') || script.includes("'Read only'"), 'read-only surfaces must carry a visible inspection cue');
assert(css.includes('.adminSurface--data table td') && css.includes('padding:8px 11px'), 'read-only tables should be denser than normal tables');
assert(css.includes('.adminSurface--control table td') && css.includes('padding:10px 11px'), 'editable tables must retain room for controls');
assert(css.includes('.adminOverviewSurface'), 'overview surfaces must have a compact, subordinate visual treatment');
assert(css.includes('.notice:not(.error):not(.warn)') && css.includes('.uiSectionHeader'), 'non-actionable information chrome should be compressed');

console.log('admin semantic surface hierarchy checks passed.');
