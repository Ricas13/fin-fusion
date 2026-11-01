'use strict';

// Real database: the customer activity query returns the new columns, and the page model built from it applies the
// watch-time rules end to end (reported vs unreported app, a runaway stale session, an open play).
require('dotenv').config();
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET ||= 'customer-playback-view-db-smoke-0123456789';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const { query } = require('../src/db');
const { runDbSmoke, unique } = require('./test-fixture');
const activity = require('../src/platform/customer-activity');

const created = { customers: [], servers: [] };

runDbSmoke('customer playback view DB smoke', async () => {
    try {
        const suffix = unique('pv');
        const server = (await query(`
            INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,location,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status,last_health_check)
            VALUES($1,$2,'custom','http://127.0.0.1:1','https://pv.invalid','Test','x',TRUE,FALSE,TRUE,1,10,'healthy',NOW()) RETURNING id
        `, [`Playback View ${suffix}`, suffix])).rows[0];
        created.servers.push(server.id);
        const customer = (await query(`INSERT INTO customers(display_name,email) VALUES('Playback View',$1) RETURNING id`, [`${suffix}@example.invalid`])).rows[0];
        created.customers.push(customer.id);
        const other = (await query(`INSERT INTO customers(display_name,email) VALUES('Someone else',$1) RETURNING id`, [`${suffix}-o@example.invalid`])).rows[0];
        created.customers.push(other.id);

        const play = (customerId, key, name, minutesAgoStart, minutesAgoEnd, flag, method = 'directplay') => query(`
            INSERT INTO playback_history(server_id,customer_id,playback_key,jellyfin_session_id,item_name,item_type,device_name,client_name,playback_method,started_at,last_seen_at,ended_at,progress_reported)
            VALUES($1,$2,$3,$4,$5,'Episode','Living','Jellyfin Android TV',$6,NOW()-($7||' minutes')::interval,NOW()-($8||' minutes')::interval,${minutesAgoEnd === null ? 'NULL' : `NOW()-($8||' minutes')::interval`},$9)
        `, [server.id, customerId, `${suffix}-${key}`, `${suffix}-s-${key}`, name, method, String(minutesAgoStart), String(minutesAgoEnd ?? 0), flag]);

        await play(customer.id, 'reported', 'Reported 45m', 120, 75, true);
        await play(customer.id, 'unreported-long', 'Moonfin style', 60 * 24 * 3, 60 * 24 * 3 - 600, false, 'transcode');
        await play(customer.id, 'runaway', 'Runaway stale session', 60 * 24 * 3, 0, true);
        await play(customer.id, 'legacy', 'Legacy row', 90, 60, null);
        await play(customer.id, 'open', 'Open play', 10, null, true);
        await play(other.id, 'other', 'Not mine', 30, 10, true);

        const data = await activity.data(customer.id, '30d', 'all');
        assert(Array.isArray(data.activity) && data.playback, 'data() returns the raw rows and the page model');
        assert.strictEqual(data.activity.length, 5, 'only this customer\'s plays');
        assert(data.activity.every(row => 'progress_reported' in row && 'duration_seconds' in row), 'the query returns the new columns');
        assert(!data.activity.some(row => row.item_name === 'Not mine'), 'another customer\'s plays are never included');
        const byTitle = Object.fromEntries(data.playback.groups.flatMap(group => group.rows).map(item => [item.title, item]));
        assert.strictEqual(byTitle['Reported 45m'].seconds, 45 * 60, 'a reporting app shows the measured time');
        assert.strictEqual(byTitle['Reported 45m'].estimate, false);
        assert.strictEqual(byTitle['Moonfin style'].estimate, true, 'an app that only reports "started" is an estimate');
        assert(byTitle['Moonfin style'].seconds <= 120 * 60, 'and is never credited beyond the activity worker\'s cap');
        assert.strictEqual(byTitle['Runaway stale session'].seconds, 12 * 3600, 'a 3-day stale session is capped at 12 hours');
        assert.strictEqual(byTitle['Legacy row'].estimate, true, 'rows recorded before progress tracking are estimates');
        assert.strictEqual(byTitle['Open play'].playingNow, true, 'an open, recently seen play is "playing now"');
        assert.strictEqual(data.playback.count, 5);
        assert(data.playback.totalSeconds > 0 && data.playback.estimated === true);
    } finally {
        await query(`DELETE FROM playback_history WHERE server_id=ANY($1::uuid[])`, [created.servers]).catch(() => {});
        await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`, [created.customers]).catch(() => {});
        await query(`DELETE FROM jellyfin_servers WHERE id=ANY($1::uuid[])`, [created.servers]).catch(error => console.warn('cleanup failed:', error.message));
    }
});
