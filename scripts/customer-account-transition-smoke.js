'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const session=read('src/auth/customer-session.js');
const claimRoute=read('src/platform/customer-claim.js');
const claims=read('src/customer-claims.js');
const pending=read('src/security/pending-registration.js');
const publicAuth=read('src/platform/customer-public-auth.js');
const security=read('src/platform/customer-security.js');

assert.match(session,/await customers\.registerCustomerSession\(req, identity\)/,'canonical customer session helper must register the persisted session');
assert.match(session,/await regenerate\(req\)/,'canonical customer session helper must regenerate the browser session');
assert.match(session,/req\.session\.csrfToken=|req\.session\.csrfToken =/,'canonical customer session helper must rotate CSRF state');

assert.match(claimRoute,/await customerSession\.establish\(req, redeemed\)/,'claim completion must use the canonical customer session helper');
assert.doesNotMatch(claimRoute,/req\.session\.customerUserId\s*=|req\.session\.customerId\s*=|req\.session\.customerUsername\s*=/,'claim route must not hand-build an unregistered customer session');
assert.match(claimRoute,/if \(redeemed\.verificationRequired\).*verificationPending/s,'email-verification claims must not establish an authenticated session before verification');
assert.match(claimRoute,/Email <span class="help">\(optional\)<\/span>/,'imported users must retain username-only claim support');

assert.match(claims,/await customers\.validateNewPassword\(password\)/,'claims must use the same breached-password policy as normal customer registration');
assert.match(claims,/if\(!email\)return\{required:false,emailLess:true\}/,'email-less imported claims must remain verification-satisfied by the schema contract');
assert.match(claims,/if\(verification\.required\)await queueVerificationTx\(client,user,verification\)/,'claim consumption and verification outbox creation must share one transaction when an email requires verification');

assert.match(pending,/await validatePassword\(password\)/,'pending registration must await the shared new-password policy');
assert.match(pending,/customers\.validateNewPassword\(password\)/,'verified registration must use breached-password checking');

const verifyRegistrationGet=publicAuth.match(/r\.get\('\/account\/verify-registration'[\s\S]*?r\.post\('\/account\/verify-registration'/)?.[0]||'';
assert(verifyRegistrationGet,'registration verification GET route missing');
assert.doesNotMatch(verifyRegistrationGet,/pendingRegistrations\.consume/,'GET registration verification must not consume the token');
assert.match(publicAuth,/r\.post\('\/account\/verify-registration'[\s\S]*?pendingRegistrations\.consume\(req\.body\.token\)/,'registration verification must consume only on POST');

const verifyEmailGet=publicAuth.match(/r\.get\('\/account\/verify-email'[\s\S]*?r\.post\('\/account\/verify-email'/)?.[0]||'';
assert(verifyEmailGet,'email verification GET route missing');
assert.doesNotMatch(verifyEmailGet,/customers\.verifyEmail/,'GET email verification must not mutate verification state');
assert.match(publicAuth,/r\.post\('\/account\/verify-email'[\s\S]*?customers\.verifyEmail\(req\.body\.token\)/,'email verification must complete only on POST');

const emailChangeGet=security.match(/router\.get\('\/account\/verify-email-change'[\s\S]*?router\.post\('\/account\/verify-email-change'/)?.[0]||'';
assert(emailChangeGet,'email-change verification GET route missing');
assert.doesNotMatch(emailChangeGet,/emailChange\.complete/,'GET email-change verification must not mutate account state');
assert.match(security,/router\.post\('\/account\/verify-email-change'[\s\S]*?emailChange\.complete\(req\.body\.token\)/,'email change must complete only on POST');
assert.doesNotMatch(security,/createCustomerSecurityRouter\(\)\{const router=express\.Router\(\);router\.use\(noStore\)/,'customer security noStore middleware must not leak to unrelated downstream routers');

console.log('customer account transition smoke: ok');
