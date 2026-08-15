'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'resellers', 'monthly-core.js'), 'utf8');

assert.match(
    source,
    /visibleOnly\) clauses\.push\('t\.visible=TRUE'\)/,
    'Reseller tier visible-only filter must qualify reseller_tiers.visible with alias t'
);
assert.match(
    source,
    /activeOnly\) clauses\.push\('t\.active=TRUE'\)/,
    'Reseller tier active-only filter must qualify reseller_tiers.active with alias t'
);
assert.doesNotMatch(
    source,
    /clauses\.push\('(visible|active)=TRUE'\)/,
    'Reseller tier filters must not use ambiguous unqualified active/visible columns'
);

console.log('reseller tier filter smoke: ok');
