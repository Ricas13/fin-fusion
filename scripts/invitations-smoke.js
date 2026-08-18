'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');

for(const retired of [
  'src/invitations.js',
  'src/platform/admin-invitations.js',
  'src/platform/invite-onboarding.js'
]){
  assert.strictEqual(fs.existsSync(path.join(root,retired)),false,`${retired} must remain retired`);
}

const application=fs.readFileSync(path.join(root,'src','application.js'),'utf8');
const nav=fs.readFileSync(path.join(root,'src','platform','admin-nav.js'),'utf8');
assert.match(application,/app\.use\('\/invite',[\s\S]*?status\(410\)/,'legacy invitation links must fail closed with 410');
assert.match(application,/app\.use\('\/admin\/invitations',[\s\S]*?\/admin\/users/,'legacy admin invitation URLs must redirect to customer management');
assert.doesNotMatch(application,/createInviteOnboardingRouter|createAdminInvitationsRouter|require\(['"]\.\/invitations['"]\)/,'retired invitation routers must not be mounted');
assert.doesNotMatch(nav,/['"]invitations['"]|\/admin\/invitations/i,'Invitations must not appear in admin navigation');

console.log('retired invitations smoke: ok');
