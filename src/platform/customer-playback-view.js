'use strict';

// Display model for the customer's "Recent playback" list: grouped by day, with an honest watch time for each play.
// Pure (no database, no HTML) so the rules are tested on their own; the template only renders what this returns.
//
// Watch time rules:
//   progress_reported = true   the app reports progress, so the measured time is shown as is.
//   progress_reported = false  the app only reported that playback started (Moonfin does this). The time is an estimate and is
//                              never credited beyond the same cap the activity worker uses (STREAM_POLICY_UNREPORTED_CREDIT_MINUTES).
//   progress_reported = null   recorded before progress reporting was tracked, so we cannot tell whether the app reported progress.
//                              Treated exactly like an unreporting app: an estimate, capped the same way (old stale sessions can span days).
// The playback method is shown as neutral wording only (never as a quality badge or colour).
// A play can never be longer than 12 hours (a session Jellyfin kept listing is not a 3-day watch).

const MAX_PLAY_SECONDS = 12 * 3600;
const PLAYING_NOW_SECONDS = 5 * 60;

function unreportedCapSeconds(env = process.env) {
    const parsed = Number.parseInt(env.STREAM_POLICY_UNREPORTED_CREDIT_MINUTES, 10);
    const minutes = Number.isFinite(parsed) ? Math.min(720, Math.max(5, parsed)) : 120;
    return minutes * 60;
}

const METHODS = Object.freeze({
    directplay: { key: 'direct', label: 'Direct play', hint: 'Played as is, with no conversion.' },
    directstream: { key: 'stream', label: 'Direct stream', hint: 'Streamed with little or no conversion.' },
    transcode: { key: 'transcode', label: 'Server transcoding', hint: 'The server converted the video for your device.' }
});

function methodOf(value) {
    return METHODS[String(value || '').toLowerCase()] || { key: 'unknown', label: 'Unknown', hint: '' };
}

// "2 hours" / "90 minutes" for explanatory text.
function capWords(seconds) {
    const minutes = Math.round(seconds / 60);
    if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
    return `${minutes} minutes`;
}

function durationLabel(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    if (minutes) return `${minutes}m`;
    return total > 0 ? '<1m' : '0m';
}

// Watch time for one row -> { seconds, estimate }.
function watchTime(row, { env = process.env } = {}) {
    const raw = Math.min(MAX_PLAY_SECONDS, Math.max(0, Number(row?.duration_seconds) || 0));
    if (row?.progress_reported === true) return { seconds: raw, estimate: false };
    return { seconds: Math.min(raw, unreportedCapSeconds(env)), estimate: true };
}

function dayKey(date, timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// The calendar day before a YYYY-MM-DD key, by calendar arithmetic (never "minus 24 hours", which is wrong across clock changes).
function previousDayKey(key) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function dayLabel(date, now, timeZone) {
    const key = dayKey(date, timeZone);
    const today = dayKey(now, timeZone);
    if (key === today) return 'Today';
    if (key === previousDayKey(today)) return 'Yesterday';
    // The year comes from the same time zone as the label (not the host's).
    const sameYear = key.slice(0, 4) === today.slice(0, 4);
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) }).format(date);
}

function timeOfDay(date, timeZone) {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(date);
}

// rows: newest first (as queried). Returns { groups, count, totalSeconds, totalLabel, estimated }.
function serverTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
}

// The page's other timestamps already use the server's time zone, so the day groups and times do too.
function prepare(rows, { now = new Date(), timeZone = serverTimeZone(), env = process.env } = {}) {
    // The query selects the most recently ACTIVE plays; the list is shown by START time, newest first, so day groups are always
    // contiguous and in order (a film started yesterday that ended after today's episode must not split or reorder the days).
    const list = (Array.isArray(rows) ? rows : [])
        .filter(row => row && !Number.isNaN(new Date(row.started_at).getTime()))
        .slice()
        .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    const prepared = list.map(row => {
        const started = new Date(row.started_at);
        const watched = watchTime(row, { env });
        const lastSeen = new Date(row.last_seen_at || row.started_at);
        const playingNow = !row.ended_at && Number.isFinite(lastSeen.getTime()) && now.getTime() - lastSeen.getTime() <= PLAYING_NOW_SECONDS * 1000;
        const method = methodOf(row.playback_method);
        return {
            title: String(row.item_name || '').trim() || 'Unknown item',
            type: String(row.item_type || '').trim(),
            device: String(row.device_name || row.client_name || '').trim() || 'Unknown device',
            client: row.device_name && row.client_name ? String(row.client_name).trim() : '',
            server: String(row.server_name || '').trim(),
            started,
            startedAt: row.started_at,
            time: timeOfDay(started, timeZone),
            seconds: watched.seconds,
            watched: durationLabel(watched.seconds),
            estimate: watched.estimate,
            playingNow,
            methodKey: method.key,
            methodLabel: method.label,
            methodHint: method.hint,
            day: dayKey(started, timeZone),
            dayLabel: dayLabel(started, now, timeZone)
        };
    });
    const longest = prepared.reduce((max, item) => Math.max(max, item.seconds), 0);
    for (const item of prepared) item.barPercent = longest > 0 ? Math.max(item.seconds > 0 ? 4 : 0, Math.round((item.seconds / longest) * 100)) : 0;
    const groups = [];
    for (const item of prepared) {
        const last = groups[groups.length - 1];
        if (last && last.day === item.day) last.rows.push(item);
        else groups.push({ day: item.day, label: item.dayLabel, rows: [item], seconds: 0 });
    }
    for (const group of groups) {
        group.seconds = group.rows.reduce((sum, item) => sum + item.seconds, 0);
        group.total = durationLabel(group.seconds);
    }
    const totalSeconds = prepared.reduce((sum, item) => sum + item.seconds, 0);
    const capSeconds = unreportedCapSeconds(env);
    return {
        groups,
        capLabel: capWords(capSeconds),
        count: prepared.length,
        totalSeconds,
        totalLabel: durationLabel(totalSeconds),
        estimated: prepared.some(item => item.estimate)
    };
}

module.exports = { serverTimeZone, MAX_PLAY_SECONDS, PLAYING_NOW_SECONDS, prepare, watchTime, durationLabel, methodOf, unreportedCapSeconds };
