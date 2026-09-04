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
    SELECT ja.server_id,COUNT(DISTINCT ja.customer_id)::int AS users
    FROM jellyfin_accounts ja
    WHERE ja.server_id=ANY($1::uuid[])
      AND ja.disabled=FALSE
      AND ja.account_purpose='jellyfin'
    GROUP BY ja.server_id
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
