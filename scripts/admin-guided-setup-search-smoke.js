'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const setupSource=read('src/platform/admin-setup.js');
const searchSource=read('src/platform/admin-search.js');
const setup=require('../src/platform/admin-setup');
const search=require('../src/platform/admin-search');

const sample={checklist:[
  {key:'affiliates',configured:false,label:'Affiliates'},
  {key:'plans',configured:false,label:'Plans'},
  {key:'jellyfin',configured:true,label:'Jellyfin'},
  {key:'email',configured:false,label:'Email'}
]};
assert.equal(setup.suggestedStep(sample)?.key,'plans','guided setup must prioritise foundational plan configuration over optional affiliate setup');
assert(setupSource.includes('Suggested next optional step'),'Setup must recommend a next step without making optional capabilities mandatory');
assert(setupSource.includes('role="progressbar"')&&setupSource.includes('optional capabilities are configured'),'Setup must expose clear optional progress');
assert(setupSource.includes('<details class="card setupAdvanced">'),'Dense readiness, portability and clean-install detail must be progressively disclosed');
assert(setupSource.includes('Configuration & dependency health'),'Live health issues must remain visible and actionable');
assert(setupSource.includes("title: 'Setup'")&&setupSource.includes('everything else stays optional'),'Setup must retain the canonical route/title while simplifying its guidance');
assert(setupSource.includes('setupReadiness()')&&setupSource.includes('configurationHealth()'),'Guided setup must reuse the existing readiness and health models rather than create parallel state');

const technical=search.technicalDetails([{label:'Plan ID',value:'123e4567-e89b-12d3-a456-426614174000'}]);
assert(technical.includes('<details class="searchTechnical">')&&technical.includes('Technical identifiers'),'Technical IDs must be behind progressive disclosure');
assert(searchSource.includes('Exact UUIDs and provider identifiers are still searchable'),'Search must explain that exact-ID troubleshooting remains supported');
assert(searchSource.includes('c.id::text ILIKE $1')&&searchSource.includes('s.id::text ILIKE $1')&&searchSource.includes('provider_subscription_id'),'Search must retain internal/provider identifier lookup capability');
assert(!searchSource.includes('class="subText fingerprint"'),'Normal search rows must not print raw identifiers inline');
assert(!searchSource.includes("'Provider IDs'"),'Billing results must not dedicate a visible column to provider identifiers');
assert(searchSource.includes('Find customers, plans, servers and billing from one place'),'Search subtitle must describe operator intent rather than implementation identities');
assert(searchSource.includes('Open customer')&&searchSource.includes('Manage plan')&&searchSource.includes('Open server'),'Search results must lead with useful actions');

console.log('guided setup and search smoke: ok');
