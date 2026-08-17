'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const placement = require('../src/jellyfin/placement');
const adminPlacement = require('../src/platform/admin-plan-placement-fleet');

(async () => {
    const plan = (await query(`
        INSERT INTO plans(code,name,description,price_minor,currency,billing_interval,duration_days,server_class,streams,active,visible,placement_strategy)
        VALUES('fleet-aware-test','Fleet Aware Test','Placement integration test',1000,'USD','month',30,'premium',3,TRUE,TRUE,'balanced')
        RETURNING *
    `)).rows[0];

    const busy = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status)
        VALUES('Legacy Busy','legacy-busy','premium','https://legacy-busy.example.test','key',TRUE,TRUE,TRUE,10,100,'healthy')
        RETURNING *
    `)).rows[0];
    const quiet = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status)
        VALUES('Managed Busy But Fleet Quiet','fleet-quiet','premium','https://fleet-quiet.example.test','key',TRUE,TRUE,TRUE,20,100,'healthy')
        RETURNING *
    `)).rows[0];
    const full = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status)
        VALUES('Fleet Full','fleet-full','premium','https://fleet-full.example.test','key',TRUE,TRUE,TRUE,1,50,'healthy')
        RETURNING *
    `)).rows[0];

    const makeCustomers = async (serverId, count, prefix) => {
        for (let i = 0; i < count; i += 1) {
            const customer = (await query(`INSERT INTO customers(display_name) VALUES($1) RETURNING id`, [`${prefix}-${i}`])).rows[0];
            await query(`
                INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled)
                VALUES($1,$2,$3,$4,FALSE)
            `, [customer.id, serverId, `${prefix}-id-${i}`, `${prefix}-${i}`]);
        }
    };
    await makeCustomers(busy.id, 2, 'legacybusy-managed');
    await makeCustomers(quiet.id, 15, 'quiet-managed');
    await makeCustomers(full.id, 1, 'full-managed');

    const now = new Date();
    await query(`
        INSERT INTO jellyfin_server_metrics(server_id,total_users,active_streams,managed_streams,observed_at)
        VALUES
            ($1,95,18,0,$4),
            ($2,30,2,0,$4),
            ($3,50,0,0,$4)
    `, [busy.id, quiet.id, full.id, now]);
    await placement.refreshFleetSnapshot();

    const candidates = [
        { ...busy, assigned_users: 2, active_streams: 0, placement_weight: 100 },
        { ...quiet, assigned_users: 15, active_streams: 0, placement_weight: 100 },
        { ...full, assigned_users: 1, active_streams: 0, placement_weight: 10000 }
    ];

    assert.strictEqual(placement.fleetLoad(candidates[0]).source, 'fleet');
    assert.strictEqual(placement.fleetLoad(candidates[0]).users, 95);
    assert.strictEqual(placement.fleetLoad(candidates[0]).streams, 18);
    assert.strictEqual(placement.atCapacity(candidates[2]), true, 'real Jellyfin users must consume max_users capacity');

    assert.strictEqual(
        placement.selectServer(candidates, 'lowest_customers').id,
        quiet.id,
        'lowest-users strategy must use actual Jellyfin users, not only CAPTAiNFiN-managed customers'
    );
    assert.strictEqual(
        placement.selectServer(candidates, 'lowest_streams').id,
        quiet.id,
        'lowest-streams strategy must use all live Jellyfin sessions'
    );
    assert.strictEqual(
        placement.selectServer(candidates, 'balanced').id,
        quiet.id,
        'balanced strategy must avoid the legacy-loaded server'
    );
    assert.notStrictEqual(
        placement.selectServer(candidates, 'weighted', { randomInt: () => 0 }).id,
        full.id,
        'weighted placement must exclude a server whose real Jellyfin capacity is full'
    );

    const pageData = await adminPlacement.placementData(plan);
    const busyPage = pageData.servers.find(row => String(row.id) === String(busy.id));
    const fullPage = pageData.servers.find(row => String(row.id) === String(full.id));
    assert.strictEqual(Number(busyPage.fleet_users), 95);
    assert.strictEqual(Number(busyPage.fleet_streams), 18);
    assert.strictEqual(placement.fleetLoad(busyPage).users, 95);
    assert.strictEqual(placement.atCapacity(fullPage), true);

    // Stale fleet data must degrade safely to managed counts rather than using
    // an old load snapshot forever or blocking all provisioning.
    await query(`UPDATE jellyfin_server_metrics SET observed_at=NOW()-INTERVAL '2 hours'`);
    await placement.refreshFleetSnapshot();
    assert.strictEqual(placement.fleetLoad(candidates[0]).source, 'managed');
    assert.strictEqual(placement.fleetLoad(candidates[0]).users, 2);
    assert.strictEqual(placement.fleetLoad(candidates[0]).streams, 0);
    assert.strictEqual(placement.atCapacity(candidates[2]), false, 'stale fleet load should fall back to managed capacity');
    assert.strictEqual(
        placement.selectServer(candidates, 'lowest_customers').id,
        full.id,
        'fallback should preserve the pre-fleet managed-count placement semantics'
    );

    console.log('fleet-aware placement smoke: ok');
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
