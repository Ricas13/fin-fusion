'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'customer-360.js'), 'utf8');

assert(source.includes("entity_type='customer' AND entity_id::text=$1::text"), 'Customer 360 audit lookup must compare audit entity UUIDs through a consistent text cast');
assert(source.includes("entity_type='subscription' AND entity_id::text IN (SELECT id::text FROM subscriptions WHERE customer_id=$1::uuid)"), 'Customer 360 subscription audit lookup must cast the route parameter explicitly before comparing it with subscriptions.customer_id');
assert(!source.includes("entity_id=$1::text"), '360 audit queries must not compare a UUID column directly to text');

console.log('customer 360 UUID audit query smoke: ok');
