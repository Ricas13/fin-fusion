'use strict';

// Customer "Recent playback": the watch-time rules, day grouping, and the rendered list (hostile data escaped, no script).
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const view = require('../src/platform/customer-playback-view');

const now = new Date('2026-11-01T15:30:00Z');
const at = (days, hours = 0, minutes = 0) => new Date(now.getTime() - days * 86400000 - hours * 3600000 - minutes * 60000).toISOString();
const row = (overrides = {}) => ({
    item_name: 'Some Show', item_type: 'Episode', device_name: 'Living', client_name: 'Jellyfin Android TV', server_name: 'Free Server',
    playback_method: 'directplay', started_at: at(0, 3), last_seen_at: at(0, 2), ended_at: at(0, 2), progress_reported: true, duration_seconds: 3600, ...overrides
});
const opts = { now, timeZone: 'UTC', env: {} };

// Watch time rules.
assert.deepStrictEqual(view.watchTime(row({ duration_seconds: 2700 }), opts), { seconds: 2700, estimate: false }, 'reported time is shown as measured');
assert.deepStrictEqual(view.watchTime(row({ progress_reported: false, duration_seconds: 9000 }), opts), { seconds: 7200, estimate: true }, 'an app that only reports "started" is capped at the activity worker\'s credit (default 120 min) and marked an estimate');
assert.deepStrictEqual(view.watchTime(row({ progress_reported: false, duration_seconds: 1800 }), opts), { seconds: 1800, estimate: true }, 'a short unreported play keeps its real length');
assert.strictEqual(view.watchTime(row({ progress_reported: false, duration_seconds: 99999 }), { env: { STREAM_POLICY_UNREPORTED_CREDIT_MINUTES: '30' } }).seconds, 1800, 'the cap follows the same setting as the activity worker');
assert.deepStrictEqual(view.watchTime(row({ progress_reported: null, duration_seconds: 5000 }), opts), { seconds: 5000, estimate: true }, 'older rows (no progress flag) are estimates');
assert.deepStrictEqual(view.watchTime(row({ progress_reported: null, duration_seconds: 3 * 86400 }), opts), { seconds: 7200, estimate: true }, 'an old row that spans days (a stale session) is capped like an unreporting app, not shown as 12 hours');
assert.strictEqual(view.watchTime(row({ progress_reported: true, duration_seconds: 3 * 86400 }), opts).seconds, 12 * 3600, 'no single play is ever longer than 12 hours (a 3-day stale session is not a 3-day watch)');
assert.strictEqual(view.watchTime(row({ duration_seconds: -50 }), opts).seconds, 0);
assert.strictEqual(view.watchTime(row({ duration_seconds: 'garbage' }), opts).seconds, 0);
assert.strictEqual(view.durationLabel(0), '0m');
assert.strictEqual(view.durationLabel(20), '<1m');
assert.strictEqual(view.durationLabel(2700), '45m');
assert.strictEqual(view.durationLabel(3720), '1h 02m');

// Grouping and totals.
const model = view.prepare([
    row({ item_name: 'A', started_at: at(0, 1), last_seen_at: at(0, 0, 2), ended_at: null, duration_seconds: 3000 }),
    row({ item_name: 'B', started_at: at(0, 5), duration_seconds: 1800 }),
    row({ item_name: 'C', started_at: at(1, 2), duration_seconds: 7200, playback_method: 'transcode' }),
    row({ item_name: 'D', started_at: at(20), duration_seconds: 600, progress_reported: false, playback_method: 'directstream' }),
    row({ item_name: '', started_at: 'not a date' })
], opts);
assert.strictEqual(model.count, 4, 'a row with no usable start time is dropped, not shown as a broken line');
assert.deepStrictEqual(model.groups.map(group => group.label), ['Today', 'Yesterday', 'Monday 12 October'], 'grouped by day with Today / Yesterday labels');
assert.deepStrictEqual(model.groups.map(group => group.rows.length), [2, 1, 1]);
assert.strictEqual(model.groups[0].total, '1h 20m', 'each day shows its total');
assert.strictEqual(model.totalSeconds, 3000 + 1800 + 7200 + 600);
assert.strictEqual(model.estimated, true);
const first = model.groups[0].rows[0];
assert.strictEqual(first.playingNow, true, 'an open play seen within 5 minutes is "playing now"');
assert.strictEqual(model.groups[0].rows[1].playingNow, false, 'an ended play never is');
assert.strictEqual(model.groups[1].rows[0].methodLabel, 'Server transcoding', 'neutral wording, as before');
assert.strictEqual(model.groups[2].rows[0].methodKey, 'stream');
assert.strictEqual(Math.max(...model.groups.flatMap(group => group.rows.map(item => item.barPercent))), 100, 'the longest play fills its bar');
assert(model.groups.flatMap(group => group.rows).every(item => item.barPercent >= 0 && item.barPercent <= 100));
assert.deepStrictEqual(view.prepare([], opts), { groups: [], count: 0, totalSeconds: 0, totalLabel: '0m', estimated: false }, 'empty is safe');
assert.strictEqual(view.prepare(null, opts).count, 0, 'null is safe');

// Rendering through the real template section.
const template = fs.readFileSync(path.join(__dirname, '..', 'views/customer/activity.ejs'), 'utf8');
const section = template.slice(template.indexOf('<section class="panel activityDetailsPanel playbackPanel"'), template.indexOf('</section>', template.indexOf('id="recent-playback"')) + 10);
assert(section.includes('playbackTable'), 'template section found');
const render = playback => ejs.render(section, { playback });
const hostile = view.prepare([row({ item_name: '<script>alert(1)</script>', device_name: '"><img src=x onerror=alert(1)>', server_name: '<b>x</b>', progress_reported: false, duration_seconds: 600 })], opts);
const html = render(hostile);
assert(!html.includes('<script') && !html.includes('<img') && !html.includes('<b>x</b>'), 'titles, devices and servers are escaped');
assert(html.includes('&lt;script&gt;'), 'the hostile text is shown as text');
assert(!/<[^>]*\son[a-z]+=/i.test(html.replace(/&lt;.*?&gt;/g, '')), 'no event-handler attributes');
assert(!/style=/i.test(html), 'no inline styles (the bar width uses a CSS class)');
assert(html.includes('≈ 10m') && html.includes('playbackEst'), 'an estimated play shows ≈ and an "est." pill');
const exact = render(view.prepare([row({ duration_seconds: 2700 })], opts));
assert(exact.includes('45m') && !exact.includes('playbackEst') && !exact.includes('≈'), 'a measured play shows its real time with no estimate marker');
assert(render(view.prepare([], opts)).includes('No playback activity has been recorded yet.'), 'empty state');
assert(render(model).includes('Yesterday') && render(model).includes('Playing now'), 'groups and live badge render');

// CSS: every bar width bucket the template can emit exists.
const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/customer-activity.css'), 'utf8');
for (let n = 0; n <= 100; n += 5) assert(css.includes(`.playbackBar .pb-${n}{`), `bar width class pb-${n} exists`);

console.log('customer playback view smoke: ok');
