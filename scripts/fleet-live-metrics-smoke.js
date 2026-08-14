'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');
const fleetMetrics = require('../src/jellyfin/fleet-metrics');
const fleetDashboard = require('../src/platform/admin-server-fleet-dashboard');

(async () => {
    const server1 = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,priority,max_users)
        VALUES('Fleet Premium','fleet-premium','premium','https://premium.example.test','test-key',TRUE,10,100)
        RETURNING id
    `)).rows[0].id;
    const server2 = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,priority,max_users)
        VALUES('Fleet Free','fleet-free','free','https://free.example.test','test-key',TRUE,20,50)
        RETURNING id
    `)).rows[0].id;

    const customer = (await query(`INSERT INTO customers(display_name,email) VALUES('Managed User','managed@example.test') RETURNING id`)).rows[0].id;
    await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username)
        VALUES($1,$2,'managed-user-id','ManagedUser')
    `, [customer, server1]);

    const originalRequest = registry.request;
    registry.request = async (serverId, path) => {
        if (path === '/Users') {
            if (String(serverId) === String(server1)) {
                return Array.from({ length: 7 }, (_, index) => ({ Id: index === 0 ? 'managed-user-id' : `legacy-${index}` }));
            }
            if (String(serverId) === String(server2)) return [{ Id: 'free-1' }, { Id: 'free-2' }];
        }
        if (String(path).startsWith('/Sessions?')) {
            if (String(serverId) === String(server1)) return [
                { Id: 's1', UserId: 'managed-user-id', NowPlayingItem: { Id: 'm1', Name: 'Managed Movie' }, PlayState: { PlayMethod: 'DirectPlay', IsPaused: false } },
                { Id: 's2', UserId: 'legacy-1', NowPlayingItem: { Id: 'm2', Name: 'Legacy Movie' }, PlayState: { PlayMethod: 'DirectStream', IsPaused: false } },
                { Id: 's3', UserId: 'legacy-2', NowPlayingItem: { Id: 'm3', Name: 'Legacy Transcode' }, PlayState: { PlayMethod: 'Transcode', IsPaused: true }, TranscodingInfo: { TranscodeReasons: ['VideoCodecNotSupported'] } },
                { Id: 'idle', UserId: 'legacy-3', PlayState: { IsPaused: false } }
            ];
            if (String(serverId) === String(server2)) return [];
        }
        throw new Error(`Unexpected request ${serverId} ${path}`);
    };

    try {
        const refreshed = await fleetMetrics.refreshAll();
        assert.strictEqual(refreshed.length, 2);
        assert(refreshed.every(row => row.ok));

        const metrics = await query(`SELECT * FROM jellyfin_server_metrics ORDER BY server_id`);
        const byServer = new Map(metrics.rows.map(row => [String(row.server_id), row]));
        const premium = byServer.get(String(server1));
        const free = byServer.get(String(server2));
        assert(premium, 'premium metrics row missing');
        assert(free, 'free metrics row missing');
        assert.strictEqual(Number(premium.total_users), 7);
        assert.strictEqual(Number(premium.active_streams), 3, 'must count unmanaged Jellyfin playback too');
        assert.strictEqual(Number(premium.managed_streams), 1, 'managed subset must remain separate');
        assert.strictEqual(Number(premium.transcode_streams), 1);
        assert.strictEqual(Number(premium.direct_stream_streams), 1);
        assert.strictEqual(Number(premium.direct_play_streams), 1);
        assert.strictEqual(Number(premium.paused_streams), 1);
        assert.strictEqual(Number(free.total_users), 2);
        assert.strictEqual(Number(free.active_streams), 0);

        const dashboardRows = await fleetDashboard.dashboardRows();
        const premiumDashboard = dashboardRows.find(row => String(row.id) === String(server1));
        assert(premiumDashboard?.fleet_metrics, 'dashboard must include cached fleet metrics');
        assert.strictEqual(Number(premiumDashboard.assigned_users), 1);
        assert.strictEqual(Number(premiumDashboard.fleet_metrics.active_streams), 3);

        let payload = null;
        await fleetDashboard.statusJson({}, { json(value) { payload = value; return value; } }, error => { throw error; });
        const status = payload.servers.find(row => String(row.id) === String(server1));
        assert(status, 'status JSON missing premium server');
        assert.strictEqual(status.totalUsers, 7);
        assert.strictEqual(status.activeStreams, 3);
        assert.strictEqual(status.managedStreams, 1);
        assert.strictEqual(status.unmanagedStreams, 2);
        assert.strictEqual(status.transcodeStreams, 1);

        console.log('fleet live metrics smoke: ok');
    } finally {
        registry.request = originalRequest;
    }
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
