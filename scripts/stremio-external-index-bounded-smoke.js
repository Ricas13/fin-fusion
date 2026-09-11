'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const source = read('src/stremio/source-index.js');
const worker = read('scripts/automation-worker.js');
const migration = read('db/migrations/20260911070000_stremio_index_bounded_sweep.sql');

assert.match(source, /const SOURCE_BATCH_LIMIT=1;/, 'external Stremio indexing must default to one source per automation pass');
assert.match(source, /async function dueSources\(\{limit=SOURCE_BATCH_LIMIT\}=\{\}\)/, 'due-source discovery must expose an explicit bounded batch');
assert.match(source, /LIMIT \$1`,\[safeLimit\]/, 'due-source SQL must apply its batch limit in the database');
assert.match(source, /Math\.min\(4,Number\(value\)\|\|SOURCE_BATCH_LIMIT\)/, 'callers must not be able to turn a bounded pass into an unbounded sweep');
assert.match(source, /remainingDue=await dueSourceCount\(\)/, 'bounded indexing must report backlog after the selected source finishes');
assert.match(source, /waiting:remainingDue/, 'remaining due sources must be visible as worker backlog telemetry');
assert.match(worker, /stremio_media_index:300/, 'new installs must revisit bounded Stremio indexing every five minutes');
assert.match(worker, /jobKey === 'stremio_media_index'/, 'automation logs must surface remaining external-index backlog');
assert.match(migration, /interval_seconds=300/, 'existing default Stremio index schedules must move to the bounded five-minute cadence');
assert.match(migration, /interval_seconds=10800/, 'migration must only rewrite the historical default rather than operator-customised schedules');

console.log('Stremio external index bounded-sweep smoke: ok');
