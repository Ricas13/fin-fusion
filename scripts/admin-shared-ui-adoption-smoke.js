'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const adopters=[
  ['src/platform/admin-attention.js',['ui.noticesFromRequest','ui.emptyState','ui.sectionHeader','ui.statusBadge']],
  ['src/platform/admin-setup.js',['ui.emptyState','ui.statusBadge']],
  ['src/platform/admin-plan-inventory.js',['ui.noticesFromRequest','ui.confirmationPanel']],
  ['src/platform/admin-integration-card.js',['ui.statusBadge']]
];
for(const [file,tokens] of adopters){const source=read(file);assert(source.includes("require('./admin-ui')"),`${file} must consume shared admin UI`);for(const token of tokens)assert(source.includes(token),`${file} is missing ${token}`);}

// Consolidation is intentionally incremental: this tranche establishes the
// canonical renderer and migrates representative high-traffic surfaces. It
// must not introduce a client framework or replace persisted workflow state.
const packageJson=read('package.json');
for(const banned of ['react','vue','svelte'])assert(!new RegExp(`"${banned}"\\s*:`,'i').test(packageJson),`shared UI consolidation must not introduce ${banned}`);

console.log('shared admin UI adoption smoke: ok');
