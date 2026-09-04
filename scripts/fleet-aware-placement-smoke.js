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
        VALUES('Managed Light / Playback Busy','managed-light','premium','https://managed-light.example.test','key',TRUE,TRUE,TRUE,10,100,'healthy')
        RETURNING *
    `)).rows[0];
    const quiet = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status)
        VALUES('Managed Heavy / Playback Quiet','managed-heavy','premium','https://managed-heavy.example.test','key',TRUE,TRUE,TRUE,20,100,'healthy')
        RETURNING *
    `)).rows[0];
    const full = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status)
        VALUES('Managed Full','managed-full','premium','https://managed-full.example.test','key',TRUE,TRUE,TRUE,1,50,'healthy')
        RETURNING *
    `)).rows[0];

    const makeCustomers = async (serverId, count, prefix) => {
        for (let i = 0; i < count; i += 1) {
            const customer = (await query(`INSERT INTO customers(display_name) VALUES($1) RETURNING id`, [`${prefix}-${i}`])).rows[0];
            await query(`
                INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose)
                VALUES($1,$2,$3,$4,FALSE,'jellyfin')
            `, [customer.id, serverId, `${prefix}-id-${i}`, `${prefix}-${i}`]);
        }
    };
    await makeCustomers(busy.id, 2, 'light-managed');
    await makeCustomers(quiet.id, 15, 'heavy-managed');
    await makeCustomers(full.id, 50, 'full-managed');

    const now = new Date();
    await query(`
        INSERT INTO jellyfin_server_metrics(server_id,total_users,active_streams,managed_streams,observed_at)
        VALUES
            ($1,95,18,0,$4),
            ($2,30,2,0,$4),
            ($3,200,0,0,$4)
    `, [busy.id, quiet.id, full.id, now]);
    await placement.refreshFleetSnapshot();

    const candidates = [
        { ...busy, assigned_users: 2, active_streams: 0, placement_weight: 100 },
        { ...quiet, assigned_users: 15, active_streams: 0, placement_weight: 100 },
        { ...full, assigned_users: 50, active_streams: 0, placement_weight: 10000 }
    ];

    // Capacity is always the managed customer count. Raw Jellyfin total_users is
    // deliberately ignored because it can include admins, service identities and
    // unmanaged accounts. Fresh fleet metrics remain useful for playback balancing.
    assert.strictEqual(placement.fleetLoad(candidates[0]).source, 'managed');
    assert.strictEqual(placement.fleetLoad(candidates[0]).users, 2);
    assert.strictEqual(placement.fleetLoad(candidates[0]).streams, 18);
    assert.strictEqual(placement.atCapacity(candidates[2]), true, '50 managed customers must fill a 50-user server');

    assert.strictEqual(
        placement.selectServer(candidates, 'lowest_customers').id,
        busy.id,
        'lowest-customers strategy must use CAPTAiNFiN managed customers, not raw Jellyfin users'
    );
    assert.strictEqual(
        placement.selectServer(candidates, 'lowest_streams').id,
        quiet.id,
        'lowest-streams strategy may use current playback as a balancing signal'
    );
    assert.strictEqual(
        placement.selectServer(candidates, 'balanced').id,
        busy.id,
        'balanced strategy must prefer the server with the lower managed-user load ratio'
    );
    assert.notStrictEqual(
        placement.selectServer(candidates, 'weighted', { randomInt: () => 0 }).id,
        full.id,
        'weighted placement must exclude a server whose managed customer count reached capacity'
    );

    const pageData = await adminPlacement.placementData(plan);
    const busyPage = pageData.servers.find(row => String(row.id) === String(busy.id));
    const fullPage = pageData.servers.find(row => String(row.id) === String(full.id));
    assert.strictEqual(Number(busyPage.assigned_users), 2);
    assert.strictEqual(Number(busyPage.fleet_streams), 18);
    assert.strictEqual(placement.fleetLoad(busyPage).users, 2);
    assert.strictEqual(placement.atCapacity(fullPage), true);

    // Stale playback metrics must not change customer capacity. They only stop
    // contributing live-stream load until a fresh sample is available.
    await query(`UPDATE jellyfin_server_metrics SET observed_at=NOW()-INTERVAL '2 hours'`);
    await placement.refreshFleetSnapshot();
    assert.strictEqual(placement.fleetLoad(candidates[0]).source, 'managed');
    assert.strictEqual(placement.fleetLoad(candidates[0]).users, 2);
    assert.strictEqual(placement.fleetLoad(candidates[0]).streams, 0);
    assert.strictEqual(placement.atCapacity(candidates[2]), true, 'stale playback metrics must not reopen a full user-capacity server');
    assert.strictEqual(
        placement.selectServer(candidates, 'lowest_customers').id,
        busy.id,
        'managed customer capacity must remain stable when playback metrics go stale'
    );

    console.log('managed-user capacity placement smoke: ok');
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});