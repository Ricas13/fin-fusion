'use strict';

const { query } = require('../db');

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function countsForServers(serverIds, db = query) {
  const ids = [...new Set((serverIds || []).map(String).filter(Boolean))];
  if (!ids.length) return new Map();
  const result = await db(`
    WITH capacity_users AS (
      SELECT ja.server_id,ja.customer_id::text AS capacity_owner
      FROM jellyfin_accounts ja
      WHERE ja.server_id=ANY($1::uuid[])
        AND ja.disabled=FALSE
        AND ja.account_purpose='jellyfin'
      UNION
      SELECT intent.server_id,intent.customer_id::text
      FROM jellyfin_account_creation_intents intent
      WHERE intent.server_id=ANY($1::uuid[])
      UNION
      SELECT lease.server_id,lease.customer_id::text
      FROM jellyfin_server_placement_leases lease
      WHERE lease.server_id=ANY($1::uuid[])
        AND lease.expires_at>NOW()
      UNION
      SELECT subscription.media_server_id,subscription.customer_id::text
      FROM subscriptions subscription
      WHERE subscription.media_server_id=ANY($1::uuid[])
        AND subscription.superseded_by IS NULL
        AND subscription.status IN('active','trialing','past_due','paused')
        AND subscription.starts_at<=NOW()
        AND subscription.current_period_end>NOW()
      UNION
      SELECT checkout.media_server_id,checkout.customer_id::text
      FROM billing_checkout_intents checkout
      WHERE checkout.media_server_id=ANY($1::uuid[])
        AND checkout.state='open'
        AND (
          (
            checkout.provider_checkout_id IS NULL
            AND checkout.expires_at>NOW()
          )
          OR (
            checkout.provider_checkout_id IS NOT NULL
            AND checkout.provider_terminal_at IS NULL
            AND COALESCE(checkout.capacity_hold_until,checkout.expires_at)>NOW()
          )
        )
      UNION
      SELECT reservation.media_server_id,
             COALESCE(reservation.customer_id::text,'free-reservation:'||reservation.id::text)
      FROM free_access_registration_reservations reservation
      WHERE reservation.media_server_id=ANY($1::uuid[])
        AND reservation.consumed_at IS NULL
        AND reservation.released_at IS NULL
        AND reservation.expires_at>NOW()
    )
    SELECT server_id,COUNT(DISTINCT capacity_owner)::int AS users
    FROM capacity_users
    GROUP BY server_id
  `, [ids]);
  return new Map(result.rows.map(row => [String(row.server_id), Number(row.users || 0)]));
}

function state(server, used = 0) {
  const users = Math.max(0, number(used, 0));
  const maxUsers = server?.max_users == null ? null : Math.max(0, number(server.max_users, 0));
  const limited = maxUsers != null && maxUsers > 0;
  const remaining = limited ? Math.max(0, maxUsers - users) : null;
  return {
    ...server,
    assigned_users: users,
    capacity_users: users,
    max_users: maxUsers,
    remaining_users: remaining,
    full: limited ? users >= maxUsers : false,
    over_capacity_by: limited ? Math.max(0, users - maxUsers) : 0
  };
}

async function decorateServers(servers, db = query) {
  const rows = Array.isArray(servers) ? servers : [];
  const counts = await countsForServers(rows.map(server => server.id), db);
  return rows.map(server => state(server, counts.get(String(server.id)) || 0));
}

async function serverState(serverId, db = query) {
  const result = await db(`
    SELECT id,name,slug,server_class,media_server_type,enabled,allow_new_users,
           trial_enabled,paid_enabled,priority,max_users,health_status,placement_mode
    FROM jellyfin_servers
    WHERE id=$1
  `, [serverId]);
  if (!result.rowCount) return null;
  const [decorated] = await decorateServers(result.rows, db);
  return decorated || null;
}

module.exports = { countsForServers, state, decorateServers, serverState };
