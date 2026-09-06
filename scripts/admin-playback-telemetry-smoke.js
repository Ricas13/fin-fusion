'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const observer = read('src/jellyfin/admin-playback-telemetry.js');
const page = read('src/platform/admin-my-activity.js');
const routes = read('src/platform/admin-route-composition.js');
const nav = read('src/platform/admin-nav.js');
const migration = read('db/migrations/20260906230000_admin_playback_telemetry.sql');

assert.match(observer, /Policy\?\.IsAdministrator\s*!==\s*true/,
  'observer must identify Jellyfin administrators from Jellyfin policy');
assert.match(observer, /INSERT INTO playback_history/,
  'telemetry-only playback must be persisted to playback history');
assert.match(observer, /customer_id,jellyfin_account_id,jellyfin_user_id/,
  'history must retain the raw Jellyfin identity while customer/account ownership remains explicit');
assert.doesNotMatch(observer, /INSERT INTO active_playback_sessions/,
  'telemetry-only administrators must never enter the active policy-session table');
assert.doesNotMatch(observer, /stream_policy_events/,
  'telemetry-only administrators must never create stream-policy decisions');
assert.match(observer, /managedUserIds/,
  'observer must avoid duplicating any Jellyfin identity that is already managed normally');

assert.match(page, /req\.session\.authUsername/,
  'personal activity must derive the identity from the signed-in staff username');
assert.match(page, /Policy\?\.IsAdministrator\s*===\s*true/,
  'personal activity must only match Jellyfin administrator identities');
assert.match(page, /liveAdminSessions/,
  'live personal playback must be read directly from Jellyfin');
assert.doesNotMatch(page, /active_playback_sessions/,
  'personal admin page must not depend on the policy-session table');
assert.match(routes, /createAdminMyActivityRouter/,
  'personal activity router must be mounted');
assert.match(nav, /\/admin\/activity\/me/,
  'personal activity must be registered in admin navigation context');

assert.match(migration, /ADD COLUMN IF NOT EXISTS jellyfin_user_id text/,
  'playback history must support telemetry-only Jellyfin identity attribution');
assert.match(migration, /WHERE jellyfin_user_id IS NOT NULL/,
  'telemetry identity index must stay partial');

console.log('Admin playback telemetry safety smoke passed.');
