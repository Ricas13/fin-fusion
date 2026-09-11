'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'automation', 'customer-inactivity.js'), 'utf8');

assert(
  source.includes('AND (ph.jellyfin_account_id=ja.id OR ph.jellyfin_account_id IS NULL)'),
  'inactivity candidates must include playback from the current account and playback orphaned by account deletion'
);

const historicalBlock = source.match(/SELECT MIN\(ph\.started_at\) historical_first_playback_at[\s\S]*?\) historical ON TRUE/);
assert(historicalBlock, 'historical playback continuity query must exist');
assert(
  !historicalBlock[0].includes('ph.started_at>=ja.access_lane_changed_at'),
  'historical activation must not be reset by access_lane_changed_at'
);

const occurrences = (source.match(/ph\.jellyfin_account_id=ja\.id OR ph\.jellyfin_account_id IS NULL/g) || []).length;
assert(
  occurrences >= 2,
  'both historical activation and rolling usage queries must preserve orphaned playback continuity'
);

console.log('customer inactivity history safety smoke: ok');
