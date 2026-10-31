'use strict';

// Playback history is the basis of the Free-access inactivity rule and of every "watched" figure,
// so its duration must reflect what was actually observed. This drives the real poller against a
// simulated Jellyfin server and checks the cases clients and outages produce.

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('playback history accuracy DB smoke')) process.exit(0);

const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');
const activity = require('../src/jellyfin/activity');
const { unique, fixtureCustomer } = require('./test-fixture');

const created = { customers: [], servers: [] };
let sessions = [];
const realRequest = registry.request;

function jellyfinSession({ id, userId, itemId, name = 'Movie', ticks = 0, paused = false, playSessionId = 'ps-1', lastActivity = new Date() }) {
  return { Id: id, UserId: userId, Client: 'TestClient', DeviceName: 'TV', NowPlayingItem: { Id: itemId, Name: name, Type: 'Movie' },
    PlayState: { PositionTicks: ticks, IsPaused: paused, PlayMethod: 'DirectPlay', PlaySessionId: playSessionId }, LastActivityDate: lastActivity.toISOString() };
}

async function row(playbackKeyLike) {
  return (await query(`SELECT *,EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at)) AS seconds FROM playback_history WHERE item_id=$1 ORDER BY id DESC LIMIT 1`, [playbackKeyLike])).rows[0];
}

async function main() {
  const tag = unique('pha');
  const customer = await fixtureCustomer({ query }, { displayName: 'Playback Accuracy', email: `${tag}@example.invalid` });
  created.customers.push(customer.id);
  const server = (await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,location,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status,last_health_check)
    VALUES($1,$2,'premium','https://pha.example.invalid','https://pha.example.invalid','PHA','key',TRUE,TRUE,TRUE,10,100,'healthy',NOW()) RETURNING id`, [tag, tag])).rows[0].id;
  created.servers.push(server);
  const jfUser = crypto.randomBytes(16).toString('hex');
  await query(`INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose) VALUES($1,$2,$3,$4,FALSE,'jellyfin')`, [customer.id, server, jfUser, tag]);
  registry.request = async (_id, path) => (String(path).startsWith('/Sessions') ? sessions : []);

  // 1. A play seen by the poller and then gone. A missed poll is tolerated for the grace period
  //    (the row stays open), and once the grace has passed the row closes at the last time
  //    Jellyfin actually reported it, so no unobserved minutes are invented.
  const itemA = `item-a-${tag}`;
  sessions = [jellyfinSession({ id: `s-${tag}`, userId: jfUser, itemId: itemA })];
  await activity.runActivityPolicyCycle();
  sessions = [];
  await activity.runActivityPolicyCycle();
  assert.strictEqual((await row(itemA)).ended_at, null, 'one missed poll is tolerated (grace) and must not close the play');
  await query(`UPDATE active_playback_sessions SET last_seen_at=NOW()-INTERVAL '5 minutes' WHERE server_id=$1`, [server]);
  await query(`UPDATE playback_history SET last_seen_at=NOW()-INTERVAL '5 minutes',started_at=NOW()-INTERVAL '35 minutes' WHERE server_id=$1 AND item_id=$2`, [server, itemA]);
  await activity.runActivityPolicyCycle();
  const a = await row(itemA);
  assert(a.ended_at, 'once the grace has passed a vanished session must be closed');
  assert.strictEqual(a.ended_reason, 'not_seen');
  assert(Math.abs(Number(a.seconds) - 30 * 60) < 5, `it must end at the last observation (30 min after the start), not when the absence was noticed (${a.seconds}s)`);

  // 2. Outage: the poller was not running for hours. Rows left open are closed when the poller
  //    returns. They must end at the last time they were actually observed, not at "now".
  const itemB = `item-b-${tag}`;
  await query(`INSERT INTO playback_history(server_id,customer_id,jellyfin_account_id,playback_key,jellyfin_session_id,item_id,item_name,client_name,device_name,playback_method,started_at,last_seen_at,access_lane_snapshot)
    SELECT $1,$2,ja.id,$3,'old-session',$4,'Outage movie','TestClient','TV','directplay',NOW()-INTERVAL '3 hours',NOW()-INTERVAL '179 minutes','primary'
    FROM jellyfin_accounts ja WHERE ja.server_id=$1 AND ja.customer_id=$2`, [server, customer.id, `key-b-${tag}`, itemB]);
  sessions = [];
  await activity.runActivityPolicyCycle();
  const b = await row(itemB);
  assert(b.ended_at, 'the stale row is closed');
  assert(Number(b.seconds) < 5 * 60, `a play last seen 179 minutes ago must not become a 3-hour watch after an outage (${Math.round(b.seconds / 60)} min)`);
  assert.strictEqual(b.ended_reason, 'not_seen');

  // 3. A client that only reports the start: Jellyfin lists the session but its position never moves.
  //    The play is flagged as having no progress reports (so the admin knows the time is an estimate).
  //    A client whose position advances is flagged as reporting properly.
  const itemC = `item-c-${tag}`, itemD = `item-d-${tag}`;
  const startOnly = jellyfinSession({ id: `sc-${tag}`, userId: jfUser, itemId: itemC, ticks: 0 });
  const reporting = jellyfinSession({ id: `sd-${tag}`, userId: jfUser, itemId: itemD, ticks: 0, playSessionId: 'ps-d' });
  sessions = [startOnly, reporting];
  await activity.runActivityPolicyCycle();
  reporting.PlayState.PositionTicks = 300000000;
  await activity.runActivityPolicyCycle();
  assert.strictEqual((await row(itemC)).progress_reported, false, 'a play whose position never moves is flagged as having no progress reports');
  assert.strictEqual((await row(itemD)).progress_reported, true, 'a play whose position advances is flagged as reporting progress');

  // 4. A session Jellyfin still lists but that has been silent and motionless for hours must stop
  //    accruing watch time and be closed, instead of growing for as long as Jellyfin lists it.
  const itemE = `item-e-${tag}`;
  const abandoned = jellyfinSession({ id: `se-${tag}`, userId: jfUser, itemId: itemE, ticks: 5, playSessionId: 'ps-e', lastActivity: new Date(Date.now() - 8 * 3600 * 1000) });
  registry.request = async (_id, path) => (String(path).includes('activeWithinSeconds') ? [] : [abandoned]);
  await query(`INSERT INTO playback_history(server_id,customer_id,jellyfin_account_id,playback_key,jellyfin_session_id,item_id,item_name,client_name,device_name,playback_method,started_at,last_seen_at,access_lane_snapshot)
    SELECT $1,$2,ja.id,$3,$4,$5,'Abandoned','TestClient','TV','directplay',NOW()-INTERVAL '8 hours',NOW()-INTERVAL '7 hours 50 minutes','primary' FROM jellyfin_accounts ja WHERE ja.server_id=$1 AND ja.customer_id=$2`,
    [server, customer.id, require('crypto').createHash('sha256').update(`${server}|se-${tag}|ps-e|${itemE}`).digest('hex'), `se-${tag}`, itemE]);
  await activity.runActivityPolicyCycle();
  await activity.runActivityPolicyCycle();
  const e = await row(itemE);
  assert.strictEqual(e.ended_reason, 'stale_session', 'a long-silent, motionless session is closed as stale');
  assert(e.ended_at, 'and it is ended');
  assert(Number(e.seconds) < 8 * 3600 - 9 * 60, `it must not keep accruing while Jellyfin lists it (${Math.round(e.seconds / 60)} min)`);
}

main()
  .then(() => console.log('playback history accuracy DB smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => {
    registry.request = realRequest;
    await query(`DELETE FROM playback_history WHERE server_id=ANY($1::uuid[])`, [created.servers]).catch(() => {});
    await query(`DELETE FROM active_playback_sessions WHERE server_id=ANY($1::uuid[])`, [created.servers]).catch(() => {});
    await query(`DELETE FROM jellyfin_accounts WHERE server_id=ANY($1::uuid[])`, [created.servers]).catch(() => {});
    await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`, [created.customers]).catch(() => {});
    await query(`DELETE FROM jellyfin_servers WHERE id=ANY($1::uuid[])`, [created.servers]).catch(() => {});
    await getPool().end().catch(() => {});
    process.exit(process.exitCode || 0);
  });
