'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const breach = require('../src/security/password-breach');
require('./customer-account-transition-smoke');

async function main() {
  const password = 'correct horse battery staple unique fixture';
  const fullHash = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const { prefix, suffix } = breach.hashParts(password);
  assert.strictEqual(prefix.length, 5, 'k-anonymity prefix must contain exactly five SHA-1 characters');
  assert.strictEqual(suffix.length, 35, 'remaining SHA-1 suffix must stay local');
  assert.strictEqual(prefix + suffix, fullHash, 'hash split must round-trip only inside the process');

  let request = null;
  breach.clearCache();
  const pwned = await breach.check(password, {
    mode: 'required',
    fetcher: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async text() { return `${suffix}:42\r\n${'A'.repeat(35)}:1\r\n`; }
      };
    }
  });
  assert.strictEqual(pwned.pwned, true, 'matching local suffix must be rejected as breached');
  assert.strictEqual(pwned.count, 42, 'breach count should be parsed without changing the decision');
  assert(request.url.endsWith(prefix), 'range request may contain only the five-character hash prefix');
  assert(!request.url.includes(password), 'plaintext password must never enter the breach-service URL');
  assert(!request.url.includes(fullHash), 'complete password hash must never enter the breach-service URL');
  assert.strictEqual(request.options.headers['Add-Padding'], 'true', 'range request should request padded responses');

  breach.clearCache();
  await assert.rejects(
    () => breach.assertNotBreached(password, {
      mode: 'required',
      fetcher: async () => ({ ok: true, status: 200, async text() { return `${suffix}:9`; } })
    }),
    error => error?.code === 'PASSWORD_BREACHED' && !String(error.message).includes('9'),
    'breached passwords must fail with a generic user-safe error'
  );

  breach.clearCache();
  const safe = await breach.check(password, {
    mode: 'required',
    fetcher: async () => ({ ok: true, status: 200, async text() { return `${'B'.repeat(35)}:4`; } })
  });
  assert.strictEqual(safe.pwned, false, 'non-matching suffix should be accepted');

  breach.clearCache();
  await assert.rejects(
    () => breach.check(password, { mode: 'required', fetcher: async () => { throw new Error('fixture network detail'); } }),
    error => error?.code === 'PASSWORD_BREACH_CHECK_UNAVAILABLE' && !String(error.message).includes('fixture network detail'),
    'required mode must fail closed without exposing provider internals'
  );
  breach.clearCache();
  const bestEffort = await breach.check(password, { mode: 'best_effort', fetcher: async () => { throw new Error('offline'); } });
  assert.strictEqual(bestEffort.checked, false, 'best-effort mode may continue when explicitly configured');

  const root = path.resolve(__dirname, '..');
  const router = fs.readFileSync(path.join(root, 'src/platform/router.js'), 'utf8');
  const customerLogin = fs.readFileSync(path.join(root, 'src/platform/customer-login.js'), 'utf8');
  const customerSecurity = fs.readFileSync(path.join(root, 'src/platform/customer-security.js'), 'utf8');
  const routeRateLimit = fs.readFileSync(path.join(root, 'src/security/route-rate-limit.js'), 'utf8');
  const customerRateLimit = fs.readFileSync(path.join(root, 'src/security/customer-rate-limit.js'), 'utf8');
  const customers = fs.readFileSync(path.join(root, 'src/customers.js'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

  const turnstileOrder = router.indexOf('router.use(publicAbuseProtection.middleware)');
  const loginRouterOrder = router.indexOf('router.use(createCustomerLoginRouter())');
  assert(turnstileOrder >= 0 && loginRouterOrder > turnstileOrder, 'customer login router must remain downstream of Turnstile');

  assert(customerLogin.includes("const routeRateLimit=require('../security/route-rate-limit');"), 'customer auth must use the canonical shared route limiter');
  assert(customerLogin.includes("scope:'customer-login-password'"), 'password authentication must have a coarse canonical route bucket');
  assert(customerLogin.includes("scope:'customer-login-2fa'"), '2FA authentication must have a coarse canonical route bucket');
  const identityLimitOrder = customerLogin.indexOf("r.post('/account/login',passwordRouteLimit,identityLoginRateLimit");
  const passwordAuthOrder = customerLogin.indexOf('customers.authenticateCustomer(req.body.identity,req.body.password)');
  assert(identityLimitOrder >= 0 && passwordAuthOrder > identityLimitOrder, 'route and identity throttles must run before password authentication');
  const twoFactorLimitOrder = customerLogin.indexOf("r.post('/account/2fa',twoFactorRouteLimit,twoFactorLoginRateLimit");
  const twoFactorVerifyOrder = customerLogin.indexOf('twoFactor.verify(pending.account.userId,req.body.code)');
  assert(twoFactorLimitOrder >= 0 && twoFactorVerifyOrder > twoFactorLimitOrder, 'route and account throttles must run before 2FA verification');
  assert.match(customerLogin,/r\.post\('\/account\/login',passwordRouteLimit,identityLoginRateLimit/,'customer-login must explicitly own and rate-limit POST /account/login');
  assert.match(customerLogin,/r\.post\('\/account\/2fa',twoFactorRouteLimit,twoFactorLoginRateLimit/,'customer-login must explicitly own and rate-limit POST /account/2fa');
  assert.doesNotMatch(customerSecurity,/router\.post\('\/account\/login'/,'customer-security must not register a second POST /account/login owner');
  assert.doesNotMatch(customerSecurity,/router\.post\('\/account\/2fa'/,'customer-security must not register a second POST /account/2fa owner');
  assert(customerLogin.includes('customer-login-identity:${identity}'), 'identity-specific login bucket must be explicit');
  assert(customerLogin.includes('limit:30,windowMs:15*60*1000'), 'identity throttle should use the higher anti-DoS threshold');
  assert(customerLogin.includes('customer-login-2fa:${userId}'), '2FA attempts must use a per-account pseudonymous bucket');
  assert(customerLogin.includes('limit:12,windowMs:10*60*1000'), '2FA throttle must bound challenge attempts independently of account lockout');
  assert(routeRateLimit.includes('return res.status(429)'), 'canonical route limiter must actively reject exhausted buckets');
  assert(customerLogin.includes("new URL(raw,'https://customer-portal.invalid')"), 'post-login redirect sanitizer must parse against a fixed internal origin');
  assert(customerLogin.includes("url.origin!=='https://customer-portal.invalid'"), 'post-login redirect sanitizer must reject cross-origin URLs');
  assert(customerLogin.includes("raw.includes('\\\\')"), 'post-login redirect sanitizer must reject browser-normalized backslashes');
  assert(customerRateLimit.includes("crypto.createHmac('sha256'"), 'raw login identities must remain HMAC-pseudonymized before persistence');
  assert(customerRateLimit.includes('const storageKey = bucketStorageKey(bucketKey)'), 'database writes must use the pseudonymous storage key');

  const validationCalls = customers.match(/await validateNewPassword\(/g) || [];
  assert(validationCalls.length >= 3, 'registration, password change and password reset must all screen new passwords');
  assert(customers.includes('async function registerCustomer') && customers.includes('async function changePortalPassword') && customers.includes('async function resetSitePassword'), 'customer password write paths must remain present');
  assert(!customers.includes('async function consumeAccountToken'), 'account tokens must not be consumed by a standalone transaction before their account mutation');
  assert.match(customers,/async function accountTokenForUpdate\(client,rawToken,tokenType\)/,'account-token lookup must require the caller transaction client');
  const verifyEmail=customers.match(/async function verifyEmail\(rawToken\)[\s\S]*?\}\)\}/)?.[0]||'';
  assert.match(verifyEmail,/transaction\(async client=>[\s\S]*?accountTokenForUpdate\(client,rawToken,'email_verify'\)[\s\S]*?UPDATE app_users[\s\S]*?UPDATE account_tokens SET consumed_at=NOW\(\)/,'email verification must mutate the account and consume its token in one transaction');
  const resetSitePassword=customers.match(/async function resetSitePassword\(rawToken,newPassword\)[\s\S]*?return true\}\)\}/)?.[0]||'';
  assert.match(resetSitePassword,/transaction\(async client=>[\s\S]*?accountTokenForUpdate\(client,rawToken,'password_reset'\)[\s\S]*?UPDATE app_users SET password_hash[\s\S]*?UPDATE auth_sessions[\s\S]*?customer\.password\.reset[\s\S]*?UPDATE account_tokens SET consumed_at=NOW\(\)/,'password reset must keep password, session, audit and token consumption in one transaction');
  assert(compose.includes('PASSWORD_BREACH_CHECK_MODE: ${PASSWORD_BREACH_CHECK_MODE:-required}'), 'production Compose should default breach screening to required');

  console.log('customer credential defense smoke passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
