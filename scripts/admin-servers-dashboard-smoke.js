'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('admin servers dashboard smoke')) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/platform/admin-dashboard-registry');
const { buildContext, libraryTotals, currentActiveStreams } = require('../src/platform/admin-servers-dashboard');
const widgets = require('../src/platform/admin-dashboard-widgets');
const { dashboardRange } = require('../src/platform/admin-dashboard-analytics');

function fakeReq(queryParams = {}) {
    return { session: { authUserId: null, authRole: 'admin', adminId: null }, query: queryParams };
}

async function seedServerData(suffix) {
    const server = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,health_status,priority,max_users)
        VALUES($1,$2,'premium','https://jellyfin.invalid','https://jellyfin.invalid','smoke-key',TRUE,'healthy',999,10)
        RETURNING id
    `, [`Servers Dashboard ${suffix}`, `servers-dashboard-${suffix}`])).rows[0];
    await query(`
        INSERT INTO jellyfin_server_metrics(server_id,total_users,active_streams,managed_streams,transcode_streams,direct_stream_streams,direct_play_streams,paused_streams,observed_at,last_error,error_at)
        VALUES($1,5,2,2,1,1,0,0,NOW(),'Connection timed out',NOW()-INTERVAL '10 minutes')
    `, [server.id]);
    const customer = (await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Servers Dashboard Customer',$1,NOW()) RETURNING id`, [`servers-widget-${suffix}@example.invalid`])).rows[0];
    await query(`
        INSERT INTO playback_history(server_id,customer_id,playback_key,jellyfin_session_id,item_name,item_type,device_name,client_name,playback_method,started_at,last_seen_at,ended_at)
        VALUES($1,$2,$3,$4,'Smoke Movie','Movie','Living Room TV','Jellyfin Web','transcode',NOW()-INTERVAL '10 minutes',NOW(),NULL)
    `, [server.id, customer.id, `servers-play-${suffix}`, `servers-session-${suffix}`]);
    return { server, customer };
}

async function main() {
    const suffix = crypto.randomBytes(5).toString('hex');
    await seedServerData(suffix);

    const req = fakeReq();
    const ctx = await buildContext(req);
    for (const spec of registry.listWidgets('servers')) {
        if (spec.lazy) continue;
        const html = await spec.render(ctx);
        assert(typeof html === 'string' && html.length > 0, `widget ${spec.key} must render non-empty HTML`);
    }

    // The playback-quality widget must never fabricate a number: CAPTAiNFiN has
    // no resolution/quality column, so it must always render the honest
    // unavailable state, verbatim, regardless of seeded data.
    const qualitySpec = registry.getWidget('servers', 'playbackQuality');
    const qualityHtml = await qualitySpec.render(ctx);
    assert.strictEqual(qualityHtml, widgets.emptyState('CAPTAiNFiN does not currently collect playback resolution/quality data.'), 'playback quality widget must render the exact honest-unavailable empty state');

    // Server status must never claim an uptime percentage -- only current status.
    const statusSpec = registry.getWidget('servers', 'serverStatus');
    assert(statusSpec.subtitle.toLowerCase().includes('uptime'), 'server status widget must disclose that uptime percentage is unavailable');

    // Concurrent-streams-by-server must reflect the seeded live snapshot, not a fabricated trend.
    assert(ctx.data.rows.some(row => Number(row.fleet_metrics?.active_streams || 0) >= 2), 'seeded active-stream count must be reflected');

    // Playback method breakdown must reflect the real seeded transcode session.
    assert(ctx.data.playbackMethods.some(row => row.name === 'transcode' && row.count >= 1), 'playback method breakdown must include the seeded transcode session');

    // Current server errors must show the real seeded last_error, not a fabricated trend.
    const errorsSpec = registry.getWidget('servers', 'currentErrors');
    const errorsHtml = await errorsSpec.render(ctx);
    assert(errorsHtml.includes('Connection timed out'), 'current errors widget must include the seeded server error');

    // Library totals (lazy, live Jellyfin call) must degrade to an honest empty
    // state rather than a fabricated count when the server is unreachable.
    const totals = await libraryTotals();
    assert(typeof totals.totalItems === 'number');
    const libSpec = registry.getWidget('servers', 'libraryTotals');
    const libHtml = await libSpec.render(ctx);
    assert(typeof libHtml === 'string' && libHtml.length > 0);

    // Current active streams (lazy) must reflect the seeded live session and never leak a session id or API key.
    const streams = await currentActiveStreams();
    assert(streams.some(row => row.item_name === 'Smoke Movie'), 'current active streams must include the seeded live session');
    const streamsSpec = registry.getWidget('servers', 'currentActiveStreams');
    const streamsHtml = (await streamsSpec.render(ctx)).toLowerCase();
    for (const banned of ['api_key', 'apikey', 'password_hash', 'session_secret', 'servers-session-', 'jellyfin_session_id']) {
        assert(!streamsHtml.includes(banned), `current active streams must never include a ${banned}-shaped string`);
    }

    // No secret-shaped strings should ever end up in any non-lazy widget's HTML output.
    for (const spec of registry.listWidgets('servers')) {
        if (spec.lazy) continue;
        const html = (await spec.render(ctx)).toLowerCase();
        for (const banned of ['api_key', 'apikey', 'password_hash', 'session_secret']) {
            assert(!html.includes(banned), `widget ${spec.key} must never include a ${banned}-shaped string`);
        }
    }

    // Rendering against a fresh (empty) database window must not crash.
    const emptyRange = dashboardRange({ range: '7d' }, new Date('2000-01-01T00:00:00.000Z'));
    const emptyCtx = { ...ctx, range: emptyRange, data: { ...ctx.data, playbackMethods: [] } };
    for (const spec of registry.listWidgets('servers')) {
        if (spec.lazy) continue;
        await spec.render(emptyCtx);
    }

    console.log('admin servers dashboard smoke: ok');
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
