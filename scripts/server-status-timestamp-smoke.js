'use strict';

const db = require('../src/db');
const serversAdmin = require('../src/platform/admin-servers');

const originalQuery = db.query;
const originalServerList = serversAdmin.serverList;
const checkedAt = new Date('2026-08-14T14:13:39.850Z');

(async () => {
    try {
        // The canonical status endpoint now lives in the fleet dashboard. Stub
        // its metrics query before requiring the module so this remains a fast,
        // database-independent contract test.
        db.query = async () => ({ rows: [] });
        serversAdmin.serverList = async () => [{
            id: 'server-1',
            name: 'Premium Jellyfin',
            slug: 'premium',
            server_class: 'premium',
            max_users: 100,
            health_status: 'healthy',
            last_health_check: checkedAt,
            assigned_users: 12,
            active_streams: 3
        }];
        delete require.cache[require.resolve('../src/platform/admin-server-fleet-dashboard')];
        const dashboard = require('../src/platform/admin-server-fleet-dashboard');

        let payload = null;
        const res = { json(value) { payload = value; return value; } };
        const next = error => { throw error; };

        await dashboard.statusJson({}, res, next);
        const server = payload?.servers?.[0];
        if (!server) throw new Error('Status endpoint did not return the server');
        if (server.lastHealthCheck !== checkedAt.toISOString()) {
            throw new Error(`Expected ${checkedAt.toISOString()}, got ${server.lastHealthCheck}`);
        }
        if (server.status !== 'healthy' || server.managedCustomers !== 12 || server.managedStreams !== 3) {
            throw new Error('Status endpoint lost server health or managed counters');
        }

        console.log('server status timestamp smoke: ok');
    } finally {
        db.query = originalQuery;
        serversAdmin.serverList = originalServerList;
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
