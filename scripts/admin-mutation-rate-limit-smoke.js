'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const text = file => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const composition = text('src/platform/admin-route-composition.js');
const limiter = text('src/security/route-rate-limit.js');

assert(
  /require\('\.\.\/security\/route-rate-limit'\)/.test(composition),
  'Admin route composition must use the shared persistent route limiter.'
);
assert(
  /scope:\s*'admin-mutation'[\s\S]*max:\s*300[\s\S]*windowSeconds:\s*60[\s\S]*reason:\s*'admin_mutation'/.test(composition),
  'Authenticated admin mutations must have the expected shared rate-limit policy.'
);
assert(
  /req\.method\s*!==\s*'POST'/.test(composition) &&
    /req\.session\?\.authUserId/.test(composition) &&
    /req\.session\?\.authRole\s*===\s*'admin'/.test(composition),
  'Admin mutation limiting must be restricted to authenticated administrator POST requests.'
);
assert(
  /app\.use\('\/admin',\s*adminMutationRateLimit\)/.test(composition),
  'Admin mutation limiting must cover the complete /admin route tree before admin handlers mount.'
);
assert(
  /return res\.status\(503\)\.send\('Security rate limiting is temporarily unavailable/.test(limiter),
  'Shared mutation rate limiting must fail closed if its backing store is unavailable.'
);

console.log('Admin mutation rate-limit regression checks passed.');
