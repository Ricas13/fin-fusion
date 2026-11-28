'use strict';

// Read-only comparison of the legacy Activity duration and the native shadow
// observation ledger. Does not adjust any entitlement or playback record.
require('dotenv').config();
const { query, getPool } = require('../src/db');
const playbackView = require('../src/platform/customer-playback-view');

async function main() {
  const identity = String(process.argv[2] || '').trim();
  if (!identity) {
    console.error('Usage: node scripts/playback-accounting-report.js <portal-or-jellyfin-username>');
    process.exitCode = 2;
    return;
  }
  const people = await query(`
    SELECT DISTINCT c.id, COALESCE(c.display_name,u.username,'Customer') AS name
    FROM customers c
    LEFT JOIN app_users u ON u.id=c.user_id
    WHERE LOWER(COALESCE(c.display_name,''))=LOWER($1)
       OR LOWER(COALESCE(u.username,''))=LOWER($1)
       OR EXISTS(
         SELECT 1 FROM jellyfin_accounts ja
         WHERE ja.customer_id=c.id AND LOWER(ja.jellyfin_username)=LOWER($1)
       )
  `, [identity]);
  if (!people.rowCount) {
    console.log('No matching customer was found.');
    return;
  }
  for (const person of people.rows) {
    const rows = await query(`
      SELECT ph.started_at,ph.ended_at,ph.last_seen_at,
             ph.item_name,ph.client_name,ph.ended_reason,ph.progress_reported,
             ph.observed_watch_seconds,ph.observed_confirmed_seconds,
             ph.observed_sample_count,ph.observed_last_source,
             ph.access_lane_snapshot,js.name AS server,
             GREATEST(0,EXTRACT(EPOCH FROM (
               COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at
             ))) AS legacy_seconds
      FROM playback_history ph
      JOIN jellyfin_servers js ON js.id=ph.server_id
      WHERE ph.customer_id=$1
        AND COALESCE(ph.ended_at,ph.last_seen_at)>=NOW()-INTERVAL '30 days'
      ORDER BY ph.started_at DESC
      LIMIT 100
    `, [person.id]);
    console.log('\nCustomer:', person.name, 'Recent sessions:', rows.rowCount);
    console.table(rows.rows.map(row => {
      const portal = playbackView.watchTime({
        duration_seconds: row.legacy_seconds,
        progress_reported: row.progress_reported
      });
      return {
        started: row.started_at,
        item: row.item_name,
        client: row.client_name,
        server: row.server,
        lane: row.access_lane_snapshot,
        legacyMinutes: +(Number(row.legacy_seconds)/60).toFixed(2),
        portalMinutes: +(portal.seconds/60).toFixed(2),
        observedMinutes: row.observed_watch_seconds == null
          ? null : +(Number(row.observed_watch_seconds)/60).toFixed(2),
        confirmedMinutes: row.observed_confirmed_seconds == null
          ? null : +(Number(row.observed_confirmed_seconds)/60).toFixed(2),
        samples: row.observed_sample_count,
        source: row.observed_last_source,
        estimatedPortal: portal.estimate,
        endedReason: row.ended_reason
      };
    }));
  }
}
main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => getPool().end());
