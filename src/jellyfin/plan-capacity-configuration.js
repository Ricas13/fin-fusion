'use strict';

const serviceCatalog = require('../catalog/service-catalog');

function mediaServerType(plan) {
  const type = serviceCatalog.serviceType(plan);
  if (type === 'emby') return 'emby';
  if (type === 'jellyfin' || type === 'bundle') return 'jellyfin';
  return null;
}

function managedMediaLimit(plan) {
  const policy = plan?.inactivity_policy && typeof plan.inactivity_policy === 'object' ? plan.inactivity_policy : {};
  return policy.mediaCapacityManaged === true && plan.capacity_limit != null ? Number(plan.capacity_limit) : null;
}

async function loadPlan(db, planId) {
  const result = await db.query('SELECT * FROM plans WHERE id=$1', [planId]);
  return result.rows[0] || null;
}

async function poolServers(db, plan, { poolMode = null, serverIds = null, serverClass = null } = {}) {
  const provider = mediaServerType(plan);
  if (!provider) return [];
  if (poolMode === 'selected') {
    const ids = Array.from(new Set((serverIds || []).map(String).filter(Boolean)));
    if (!ids.length) return [];
    const result = await db.query(`
      SELECT id,name,max_users,server_class,COALESCE(media_server_type,'jellyfin') AS media_server_type
      FROM jellyfin_servers
      WHERE id=ANY($1::uuid[])
        AND COALESCE(media_server_type,'jellyfin')=$2
    `, [ids, provider]);
    return result.rows;
  }

  if (poolMode == null) {
    const mapped = await db.query(`
      SELECT js.id,js.name,js.max_users,js.server_class,COALESCE(js.media_server_type,'jellyfin') AS media_server_type
      FROM plan_server_eligibility pse
      JOIN jellyfin_servers js ON js.id=pse.server_id
      WHERE pse.plan_id=$1
        AND COALESCE(js.media_server_type,'jellyfin')=$2
    `, [plan.id, provider]);
    if (mapped.rowCount) return mapped.rows;
  }

  const cls = String(serverClass || plan.server_class || '').trim();
  const fallback = await db.query(`
    SELECT id,name,max_users,server_class,COALESCE(media_server_type,'jellyfin') AS media_server_type
    FROM jellyfin_servers
    WHERE COALESCE(media_server_type,'jellyfin')=$1
      AND server_class=$2
  `, [provider, cls]);
  return fallback.rows;
}

async function poolCapacity(db, plan, options = {}) {
  const servers = await poolServers(db, plan, options);
  const missing = servers.filter(server => server.max_users == null || Number(server.max_users) < 1);
  const capacity = servers.reduce((sum, server) => sum + Math.max(0, Number(server.max_users || 0)), 0);
  return { servers, missing, capacity };
}

async function assertPlanLimitWithinPool(db, {
  planId,
  limit = undefined,
  poolMode = null,
  serverIds = null,
  serverClass = null
}) {
  const plan = await loadPlan(db, planId);
  if (!plan) throw new Error('Plan not found.');
  if (!mediaServerType(plan)) return { plan, capacity: null, servers: [] };
  const effectiveLimit = limit === undefined ? managedMediaLimit(plan) : (limit == null ? null : Number(limit));
  if (effectiveLimit == null) return { plan, capacity: null, servers: [] };

  const pool = await poolCapacity(db, plan, { poolMode, serverIds, serverClass });
  if (pool.missing.length) {
    throw new Error(`Set physical customer capacity on every selected media server before configuring a plan customer limit. Missing: ${pool.missing.map(server => server.name).join(', ')}.`);
  }
  if (!pool.servers.length && effectiveLimit > 0) {
    throw new Error('This plan has no media servers with configured physical capacity.');
  }
  if (effectiveLimit > pool.capacity) {
    throw new Error(`Maximum customers on this plan cannot exceed the selected server pool capacity of ${pool.capacity}.`);
  }
  return { plan, capacity: pool.capacity, servers: pool.servers };
}

async function impactedManagedPlans(db, serverId, { oldClass = null, newClass = null, oldProvider = null, newProvider = null } = {}) {
  const classes = Array.from(new Set([oldClass, newClass].map(value => String(value || '').trim()).filter(Boolean)));
  const providers = Array.from(new Set([oldProvider, newProvider].map(value => String(value || 'jellyfin').trim()).filter(Boolean)));
  const result = await db.query(`
    SELECT DISTINCT p.id
    FROM plans p
    WHERE COALESCE(p.inactivity_policy->>'mediaCapacityManaged','false')='true'
      AND p.capacity_limit IS NOT NULL
      AND (
        EXISTS(SELECT 1 FROM plan_server_eligibility pse WHERE pse.plan_id=p.id AND pse.server_id=$1)
        OR (
          NOT EXISTS(
            SELECT 1
            FROM plan_server_eligibility pse
            JOIN jellyfin_servers js ON js.id=pse.server_id
            WHERE pse.plan_id=p.id
              AND COALESCE(js.media_server_type,'jellyfin')=CASE WHEN p.service_type='emby' THEN 'emby' ELSE 'jellyfin' END
          )
          AND p.server_class=ANY($2::text[])
          AND CASE WHEN p.service_type='emby' THEN 'emby' ELSE 'jellyfin' END=ANY($3::text[])
        )
      )
  `, [serverId, classes.length ? classes : ['__none__'], providers.length ? providers : ['__none__']]);
  return result.rows.map(row => row.id);
}

module.exports = {
  mediaServerType,
  managedMediaLimit,
  loadPlan,
  poolServers,
  poolCapacity,
  assertPlanLimitWithinPool,
  impactedManagedPlans
};
