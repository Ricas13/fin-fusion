'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const source=fs.readFileSync(path.join(__dirname,'..','public','js','operator-business-indicators.js'),'utf8');

assert(source.includes('function relocatePageActions()'), 'admin header must keep relocating page actions into the CURRENT/RELATED row');
assert(source.includes(".topStatusWrap,.topHelpLink,[data-operator-header-metrics]"), 'status, help and shared metrics must stay in the global header');
assert(source.includes('<span>Monthly revenue</span>'), 'admin header must show the monthly revenue metric');
assert(!source.includes('Revenue M/Y'), 'admin header must not show combined month/year revenue');
assert(!source.includes('yearlyRevenue'), 'admin header must not render yearly revenue');
assert(!source.includes('Today revenue')&&!source.includes('Week revenue'), 'admin header must not render today/week revenue metrics');
assert(source.includes('`${active}/${total}`'), 'stream metric must render live streams over total configured stream capacity');
assert(source.includes("'—/—'"), 'stream metric fallback must retain the compact live/total shape');

console.log('admin header business metrics smoke: ok');
