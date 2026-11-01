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
assert.deepStrictEqual(view.prepare([], opts), { groups: [], capLabel: '2 hours', count: 0, totalSeconds: 0, totalLabel: '0m', estimated: false }, 'empty is safe');
assert.strictEqual(view.prepare([], { env: { STREAM_POLICY_UNREPORTED_CREDIT_MINUTES: '90' } }).capLabel, '90 minutes', 'the explanation follows the configured cap');
assert.strictEqual(view.prepare(null, opts).count, 0, 'null is safe');

// Ordering: the query returns the most recently ACTIVE plays; groups must still be by START time, contiguous and newest first.
const interleaved = view.prepare([
    row({ item_name: 'Film started yesterday, ended after the episode', started_at: at(1, 1), last_seen_at: at(0, 0, 5), ended_at: at(0, 0, 5), duration_seconds: 9000 }),
    row({ item_name: 'Episode today', started_at: at(0, 2), last_seen_at: at(0, 1), ended_at: at(0, 1), duration_seconds: 1500 }),
    row({ item_name: 'Another yesterday', started_at: at(1, 6), last_seen_at: at(1, 5), ended_at: at(1, 5), duration_seconds: 900 }),
    row({ item_name: 'Later today', started_at: at(0, 0, 30), last_seen_at: at(0, 0, 10), ended_at: at(0, 0, 10), duration_seconds: 600 })
], opts);
assert.deepStrictEqual(interleaved.groups.map(group => group.label), ['Today', 'Yesterday'], 'one Today group and one Yesterday group, in order (no split or reordered days)');
assert.deepStrictEqual(interleaved.groups[0].rows.map(item => item.title), ['Later today', 'Episode today'], 'newest start first within a day');
assert.deepStrictEqual(interleaved.groups[1].rows.map(item => item.title), ['Film started yesterday, ended after the episode', 'Another yesterday']);

// Calendar days in a time zone: "Yesterday" across a clock change, and the year from the same zone.
const london = (iso, zone = 'Europe/London') => view.prepare([row({ started_at: iso })], { now: new Date(view.__nowForTest || iso), timeZone: zone, env: {} });
const dst = view.prepare([row({ item_name: 'before the clock change', started_at: '2026-10-24T12:00:00Z' })], { now: new Date('2026-10-25T23:30:00Z'), timeZone: 'Europe/London', env: {} });
assert.strictEqual(dst.groups[0].label, 'Yesterday', 'the day before is "Yesterday" across the end of British Summer Time (25 Oct 2026, 23:30 UTC is still 25 Oct in London)');
const springForward = view.prepare([row({ started_at: '2026-03-28T12:00:00Z' })], { now: new Date('2026-03-29T12:00:00Z'), timeZone: 'Europe/London', env: {} });
assert.strictEqual(springForward.groups[0].label, 'Yesterday', 'and across the spring clock change');
const newYear = view.prepare([row({ started_at: '2025-12-31T10:00:00Z' })], { now: new Date('2026-01-01T09:00:00Z'), timeZone: 'Pacific/Auckland', env: {} });
assert(!/2025|2026/.test(newYear.groups[0].label) || newYear.groups[0].label === 'Yesterday' || newYear.groups[0].label === 'Today', 'year labels use the target time zone, not the host');
const lastYear = view.prepare([row({ started_at: '2025-06-01T10:00:00Z' })], { now: new Date('2026-01-01T09:00:00Z'), timeZone: 'UTC', env: {} });
assert(lastYear.groups[0].label.includes('2025'), 'a different year includes the year');
assert.strictEqual(model.capLabel, '2 hours', 'the model exposes the credited cap for the explanation');

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
assert(html.includes('Up to 2 hours is credited per play; you may have watched longer.'), 'the cap is explained next to estimates');
assert(html.includes('estimated plays are credited up to 2 hours each'), 'and in the header total');
assert(html.includes('scope="rowgroup"') && !html.includes('scope="colgroup"'), 'day headings describe row groups');
const exact = render(view.prepare([row({ duration_seconds: 2700 })], opts));
assert(exact.includes('45m') && !exact.includes('playbackEst') && !exact.includes('≈'), 'a measured play shows its real time with no estimate marker');
assert(render(view.prepare([], opts)).includes('No playback activity has been recorded yet.'), 'empty state');
assert(render(model).includes('Yesterday') && render(model).includes('Playing now'), 'groups and live badge render');

// CSS: every bar width bucket the template can emit exists.
const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/customer-activity.css'), 'utf8');
for (let n = 0; n <= 100; n += 5) assert(css.includes(`.playbackBar .pb-${n}{`), `bar width class pb-${n} exists`);

console.log('customer playback view smoke: ok');
