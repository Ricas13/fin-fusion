'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const session=read('src/auth/customer-session.js');
const customersSource=read('src/customers.js');
const referralsSource=read('src/referrals.js');
const claimRoute=read('src/platform/customer-claim.js');
const claims=read('src/customer-claims.js');
const pending=read('src/security/pending-registration.js');
const publicAuth=read('src/platform/customer-public-auth.js');
const login=read('src/platform/customer-login.js');
const security=read('src/platform/customer-security.js');
const publicErrorSource=read('src/platform/public-error.js');
const publicErrors=require(path.join(root,'src/platform/public-error.js'));

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

assert.match(customersSource,/registerCustomer\(\{email,username,password,referralCode,communicationPreferences=null\}\)/,'direct registration must accept normalized communication preferences as part of the transition');
const registrationTransaction=customersSource.match(/async function registerCustomer[\s\S]*?return created\}/)?.[0]||'';
assert(registrationTransaction,'customer registration transaction missing');
assert.match(registrationTransaction,/transaction\(async client=>[\s\S]*?client\.query\(`INSERT INTO customer_communication_preferences/,'direct registration must persist communication preferences through the registration transaction client');
assert.match(registrationTransaction,/customer_communication_preferences[\s\S]*?audit_log[\s\S]*?return\{user,customer,referralCodeId\}/,'communication preferences and referral attribution must be persisted before the registration transaction returns the identity');
assert.match(registrationTransaction,/referrals\.attributionEnabled\(client\)[\s\S]*?referrals\.attributeReferral\(customer\.id,referralCode,client\)/,'direct registration referral attribution must use the same transaction client as customer creation');
assert.doesNotMatch(registrationTransaction,/Referral attribution failed|referrals\.attributeReferral\(created\.customer\.id/,'direct registration must not defer referral attribution until after commit');
assert.match(publicAuth,/customers\.registerCustomer\(\{\.\.\.req\.body,referralCode:req\.body\.referralCode,communicationPreferences\}\)/,'the public registration route must hand preferences to the atomic customer registration transition');
assert.doesNotMatch(publicAuth,/function saveCommunication|await saveCommunication\(/,'the public registration route must not perform a second communication-preferences write after identity creation');

const pendingConsume=pending.match(/async function consume\(rawToken\)[\s\S]*?return created;\n\}/)?.[0]||'';
assert(pendingConsume,'verified registration consume transition missing');
assert.match(pendingConsume,/referrals\.attributionEnabled\(client\)[\s\S]*?referrals\.attributeReferral\(customer\.id,pending\.referral_code,client\)/,'verified registration referral attribution must use the same transaction client as account creation and token consumption');
assert.doesNotMatch(pendingConsume,/Verified registration referral attribution failed|referrals\.attributeReferral\(created\.customer\.id/,'verified registration must not defer referral attribution until after commit');
assert.match(referralsSource,/async function attributeReferral\(referredCustomerId,rawCode,client=null\)/,'referral attribution must accept an explicit transaction client');
assert.match(referralsSource,/ON CONFLICT\(referred_customer_id\) DO NOTHING RETURNING referral_code_id/,'referral conflict handling must report the persisted attribution instead of the attempted code');

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

assert.equal(publicErrors.isSafe({message:'This claim link is invalid or expired.'}),true,'known claim validation errors should remain customer-visible');
assert.equal(publicErrors.isSafe({code:'PASSWORD_BREACHED',message:'password rejected'}),true,'known safe customer error codes should remain customer-visible');
assert.equal(publicErrors.isSafe({message:'Plan is not available or is currently sold out.'}),true,'known Free Access availability feedback should remain customer-visible');
assert.equal(publicErrors.isSafe({message:'duplicate key value violates unique constraint "app_users_email_key"'}),false,'database errors must fail closed at the public boundary');
assert.match(publicErrorSource,/crypto\.randomBytes\(6\)/,'unexpected public errors must receive a short reference id');
assert.match(publicErrorSource,/status:\s*500/,'unexpected public errors must be reported as server failures');
assert.match(publicErrorSource,/console\.error\(`\$\{context\} \[\$\{reference\}\]`, error\)/,'unexpected public errors must be logged server-side with their reference');
assert.match(claimRoute,/const publicError = require\('\.\/public-error'\)/,'public claim route must use the shared public error presenter');
const redeemCatch=claimRoute.match(/redeemed = await claims\.redeemClaim[\s\S]*?if \(redeemed\.verificationRequired\)/)?.[0]||'';
assert(redeemCatch,'public claim redemption block missing');
assert.match(redeemCatch,/publicError\.present\(error/,'public claim redemption failures must pass through the shared presenter');
assert.doesNotMatch(redeemCatch,/publicForm\([^\n]*error\.message/,'public claim form must not render raw redemption exception messages');
const claimErrorMiddleware=claimRoute.match(/router\.use\('\/claim', \(error,[\s\S]*?return router;/)?.[0]||'';
assert(claimErrorMiddleware,'public claim error middleware missing');
assert.match(claimErrorMiddleware,/publicError\.present\(error/,'outer public claim failures must pass through the shared presenter');
assert.doesNotMatch(claimErrorMiddleware,/unavailable\(error\.message/,'outer public claim failures must not render raw exception messages');

assert.match(publicAuth,/const publicError=require\('\.\/public-error'\)/,'public registration/reset routes must use the shared public error presenter');
assert.match(publicAuth,/Customer registration failed/,'registration failures must use the public error boundary');
assert.match(publicAuth,/Verified registration completion failed/,'verified-registration failures must use the public error boundary');
assert.match(publicAuth,/Customer password reset failed/,'password-reset failures must use the public error boundary');
assert.doesNotMatch(publicAuth,/registrationLocals\(req,error\.message|error:error\.message|Verification failed',error\.message/,'public auth responses must not render raw exception messages');
assert.match(publicAuth,/Customer password-reset request failed[\s\S]*?return message\(res,200,'Check your email','If a matching customer account with an email address exists/,'forgot-password infrastructure failures must preserve the neutral anti-enumeration response');

assert.match(login,/const publicError=require\('\.\/public-error'\)/,'customer login/profile routes must use the shared public error presenter');
assert.match(login,/Customer login failed/,'customer login failures must use the public error boundary');
assert.match(login,/Customer profile update failed/,'customer profile failures must use the public error boundary');
assert.doesNotMatch(login,/render\('customer\/login',\{error:error\.message|confirmationPage\([^\n]*error:error\.message|encodeURIComponent\(error\.message\)|twoFactorPasswordPage\(req,error\.message/,'customer login/profile responses must not expose raw exception messages');

assert.match(security,/const publicError=require\('\.\/public-error'\)/,'customer security routes must use the shared public error presenter');
assert.match(security,/function securityError\(res,error,context/,'customer security redirects must share one error boundary');
assert.doesNotMatch(security,/encodeURIComponent\(error\.message\)|esc\(error\.message\)|error:error\.message/,'customer security responses must not expose raw exception messages');
assert.match(security,/Customer email-change verification failed/,'email-change confirmation failures must use the public error boundary');
assert.match(security,/Customer password change failed/,'password-change failures must use the public error boundary');
assert.match(security,/Customer 2FA enrollment confirmation failed/,'2FA enrollment failures must use the public error boundary');

console.log('customer account transition smoke: ok');