'use strict';

const assert = require('assert');
const csrf = require('../src/auth/csrf');
const sessionGuard = require('../src/auth/session-guard');

function request({ method='POST', path='/account/profile', session={} }={}) {
  return {
    method,
    path,
    session,
    body: {},
    headers: {},
    get(name){ return this.headers[String(name).toLowerCase()] || ''; }
  };
}
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code){ this.statusCode=code; return this; },
    send(body){ this.body=body; return this; }
  };
}

for (const method of ['POST','PUT','PATCH','DELETE']) {
  assert.strictEqual(sessionGuard.csrfRequiredForAuthenticatedMutation(request({method,path:'/admin/users/1'}),'admin'),true,`${method} /admin must require CSRF for an authenticated administrator`);
  assert.strictEqual(sessionGuard.csrfRequiredForAuthenticatedMutation(request({method,path:'/account/profile'}),'customer'),true,`${method} /account must require CSRF for an authenticated customer`);
  assert.strictEqual(sessionGuard.csrfRequiredForAuthenticatedMutation(request({method,path:'/account/future-route',session:{impersonation:{id:'x'}}}),'admin'),true,`${method} impersonated /account mutations must retain the authenticated CSRF boundary`);
}
for (const method of ['GET','HEAD','OPTIONS']) {
  assert.strictEqual(sessionGuard.csrfRequiredForAuthenticatedMutation(request({method,path:'/admin/users'}),'admin'),false,`${method} admin reads must not require CSRF`);
  assert.strictEqual(sessionGuard.csrfRequiredForAuthenticatedMutation(request({method,path:'/account'}),'customer'),false,`${method} customer reads must not require CSRF`);
  assert.strictEqual(sessionGuard.csrfRequiredForAuthenticatedMutation(request({method,path:'/account',session:{impersonation:{id:'x'}}}),'admin'),false,`${method} impersonated reads must remain non-mutating`);
}
assert.strictEqual(sessionGuard.csrfRequiredForAuthenticatedMutation(request({method:'POST',path:'/webhooks/stripe'}),'admin'),false,'external webhooks are outside the authenticated admin/account CSRF boundary');
assert.strictEqual(sessionGuard.csrfRequiredForAuthenticatedMutation(request({method:'POST',path:'/account/login'}),'guest'),false,'unauthenticated login remains outside the authenticated-session boundary');

const reqMissing=request({method:'POST',path:'/account/future-route',session:{}});
const resMissing=response();
let nextCalls=0;
sessionGuard.continueAuthenticated(reqMissing,resMissing,()=>{nextCalls+=1;},'customer');
assert.strictEqual(resMissing.statusCode,403,'missing CSRF token must fail closed for any future authenticated account mutation');
assert.strictEqual(nextCalls,0,'missing CSRF token must not reach the route handler');

const reqValid=request({method:'POST',path:'/account/future-route',session:{}});
const token=csrf.token(reqValid);
reqValid.body._csrf=token;
const resValid=response();
sessionGuard.continueAuthenticated(reqValid,resValid,()=>{nextCalls+=1;},'customer');
assert.strictEqual(nextCalls,1,'valid CSRF token must allow the authenticated mutation to continue');

const impMissing=request({method:'POST',path:'/account/access/media/account-1/username',session:{impersonation:{id:'x'}}});
const impMissingRes=response();
sessionGuard.continueAuthenticated(impMissing,impMissingRes,()=>{nextCalls+=1;},'admin');
assert.strictEqual(impMissingRes.statusCode,403,'editable impersonation must reject account writes without CSRF before the no-spend policy runs');

const impValid=request({method:'POST',path:'/account/access/media/account-1/username',session:{impersonation:{id:'x'}}});
const impToken=csrf.token(impValid);
impValid.body._csrf=impToken;
const impValidRes=response();
sessionGuard.continueAuthenticated(impValid,impValidRes,()=>{nextCalls+=1;},'admin');
assert.strictEqual(nextCalls,2,'valid CSRF must allow an impersonated non-spending mutation to reach the later policy/router');

console.log('authenticated admin/customer/impersonation CSRF boundary smoke: ok');