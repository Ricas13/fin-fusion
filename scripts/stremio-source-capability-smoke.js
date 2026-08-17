'use strict';

const assert=require('assert');
process.env.SESSION_SECRET='capability-smoke-session-secret-that-is-definitely-long-enough-2026';
const capability=require('../src/stremio/source-capability');

const now=Date.UTC(2026,7,17,12,0,0);
const token=capability.issue('entitlement-1','source-1','item-1','media-1',{now});
assert(capability.verify(token,'entitlement-1','source-1','item-1','media-1',{now:now+1000}),'Issued playback capability must verify for its exact scope');
assert(!capability.verify(token,'entitlement-2','source-1','item-1','media-1',{now:now+1000}),'Capability must be entitlement-bound');
assert(!capability.verify(token,'entitlement-1','source-2','item-1','media-1',{now:now+1000}),'Capability must be source-bound');
assert(!capability.verify(token,'entitlement-1','source-1','item-2','media-1',{now:now+1000}),'Capability must be item-bound');
assert(!capability.verify(token,'entitlement-1','source-1','item-1','media-2',{now:now+1000}),'Capability must be media-source-bound');
assert(!capability.verify(token,'entitlement-1','source-1','item-1','media-1',{now:now+(capability.TTL_SECONDS+2)*1000}),'Expired playback capability must fail closed');
const tampered=token.slice(0,-1)+(token.endsWith('A')?'B':'A');
assert(!capability.verify(tampered,'entitlement-1','source-1','item-1','media-1',{now:now+1000}),'Tampered playback capability must fail closed');
console.log('stremio source capability smoke: ok');
