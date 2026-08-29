'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'src/stremio/runtime.js'), 'utf8');
const limiterSource = fs.readFileSync(path.join(root, 'src/security/route-rate-limit.js'), 'utf8');

// Stremio is sold as household access with unlimited devices/streams. A single
// household can legitimately have many clients refreshing results at once, so
// the public Stremio protocol routes must not have per-token request throttles.
assert(!runtimeSource.includes("require('../security/route-rate-limit')"), 'Stremio runtime must not depend on the route rate limiter');
assert(!runtimeSource.includes('manifestLimit'), 'Stremio manifest requests must not be request-rate limited');
assert(!runtimeSource.includes('streamLimit'), 'Stremio stream-result requests must not be request-rate limited');
assert(!runtimeSource.includes('playbackLimit'), 'Stremio playback compatibility requests must not be request-rate limited');
assert(!runtimeSource.includes('protocol_rate_limit'), 'Stremio runtime must not emit protocol rate-limit rejections');
assert(runtimeSource.includes("router.get('/stremio/:token/manifest.json', async"), 'manifest route must mount directly without a limiter middleware');
assert(runtimeSource.includes("router.get('/stremio/:token/stream/:type/:videoId.json', async"), 'stream route must mount directly without a limiter middleware');
assert(runtimeSource.includes("router.get('/stremio/:token/household-blocked/:type/:videoId.mp4', sendHouseholdBlockedMedia)"), 'blocked-media route must mount directly without a limiter middleware');

// Sensitive authentication/mutation routes elsewhere still use the canonical
// database-backed limiter. Removing Stremio throttling must not weaken that
// shared security default.
assert(limiterSource.includes("backend = 'database'"), 'shared database rate limiting must remain the default for sensitive routes');

console.log('stremio unlimited request contract smoke: ok');
