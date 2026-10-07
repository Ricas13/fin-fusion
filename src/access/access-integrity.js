'use strict';

const { query } = require('../db');

function clean(value, max = 900) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function finding(kind, row, detail) {
  return {
    kind,
    id: String(row.id || row.subscription_id || row.customer_id || 'unknown'),
    customerId: row.customer_id || null,
    detail: clean(detail)
  };
}

function freeScopedAccessBlockedSql(alias = 's', planAlias = 'p') {
  return `EXISTS(
    SELECT 1
    FROM customer_access_holds integrity_hold
    WHERE integrity_hold.customer_id=${alias}.customer_id
      AND integrity_hold.released_at IS NULL
      AND (
        (
          integrity_hold.hold_type='inactivity_policy'
          AND integrity_hold.source_key=('plan:'||${planAlias}.id::text)
          AND (
            integrity_hold.metadata->>'subscriptionId'=${alias}.id::text
            OR (
              integrity_hold.metadata->>'subscriptionId' IS NULL
              AND integrity_hold.created_at>=${alias}.created_at
            )
          )
        )
        OR (
          integrity_hold.hold_type='jellyfin_cleanup'
          AND EXISTS(
            SELECT 1
            FROM jellyfin_accounts integrity_free_account
            WHERE integrity_free_account.customer_id=${alias}.customer_id
              AND integrity_free_account.account_purpose='jellyfin'
              AND integrity_free_account.access_lane='free'
              AND integrity_hold.source_key=('server:'||integrity_free_account.server_id::text)
          )
        )
      )
  )`;
}

function mediaAssignmentMatchesSql(subscriptionAlias = 's', accountAlias = 'ja') {
  const effectiveServer = `COALESCE(
    (
      SELECT integrity_ctl.server_id
      FROM customer_service_admin_control integrity_ctl
      WHERE integrity_ctl.customer_id=${subscriptionAlias}.customer_id
        AND integrity_ctl.service='jellyfin'
        AND integrity_ctl.mode='admin_server_pin'
      LIMIT 1
    ),
    ${subscriptionAlias}.media_server_id
  )`;
  return `(${effectiveServer} IS NULL OR ${accountAlias}.server_id=${effectiveServer})`;
}

function automaticAccessAllowedSql(alias = 's', { free = false, planAlias = 'p' } = {}) {
  const scopedFreeBlock = free ? ` OR ${freeScopedAccessBlockedSql(alias, planAlias)}` : '';
  return `(
    EXISTS(
      SELECT 1
      FROM customer_entitlement_overrides integrity_override
      WHERE integrity_override.customer_id=${alias}.customer_id
        AND integrity_override.subscription_id=${alias}.id
        AND integrity_override.permanent_access=TRUE
        AND integrity_override.revoked_at IS NULL
    )
    OR public.subscription_admin_present(${alias}.customer_id,'jellyfin',${alias}.id)
    OR NOT (
      public.subscription_access_blocked(${alias}.customer_id,${alias}.source,${alias}.provider_subscription_id)
      ${scopedFreeBlock}
    )
  )`;
}

function liveEntitlementSql({ free = null, alias = 's', planAlias = 'p' } = {}) {
  const freeFilter = free === true
    ? `AND COALESCE(${planAlias}.is_free_tier,FALSE)=TRUE`
    : free === false
      ? `AND COALESCE(${planAlias}.is_free_tier,FALSE)=FALSE`
      : '';
  return `
    ${freeFilter}
    AND COALESCE(${planAlias}.is_addon,FALSE)=FALSE
    AND COALESCE(NULLIF(${alias}.service_type_snapshot,''),${planAlias}.service_type,'jellyfin') IN('jellyfin','bundle')
    AND ${alias}.superseded_by IS NULL
    AND ${alias}.starts_at<=NOW()
    AND (
      public.subscription_admin_present(${alias}.customer_id,'jellyfin',${alias}.id)
      OR (${alias}.status IN('active','trialing','past_due','paused') AND ${alias}.current_period_end>NOW())
      OR (
        COALESCE(${alias}.service_extension_days,0)>0
        AND ${alias}.status IN('active','trialing','past_due','paused','cancelled','expired')
        AND (${alias}.current_period_end+((${alias}.service_extension_days||' days')::interval))>NOW()
      )
      OR EXISTS(
        SELECT 1
        FROM customer_entitlement_overrides o
        WHERE o.customer_id=${alias}.customer_id
          AND o.subscription_id=${alias}.id
          AND o.permanent_access=TRUE
          AND o.revoked_at IS NULL
      )
    )
  `;
}

async function scan({ limit = 100 } = {}) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const freeLive = liveEntitlementSql({ free: true });
  const primaryLive = liveEntitlementSql({ free: false });

  const [
    freePlanWithoutServer,
    failedFreeRestores,
    freeServerWithoutPlan,
    unpaidTrialWithoutServer,
    primaryServerWithoutPlan,
    paidPlanWithoutRecovery,
    stremioMissingInstallCredential,
    stremioMissingRecoverableLink,
    staleActiveStremioEntitlement,
    externalStremioPlaybackCredentialGap,
    externalStremioIndexCountDrift,
    managedStremioIndexCountDrift
  ] = await Promise.all([
    query(`
      SELECT s.id AS subscription_id,s.customer_id,p.code AS plan_code,s.created_at
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      WHERE TRUE ${freeLive}
        AND NOT public.subscription_admin_removed(s.customer_id,'jellyfin')
        AND ${automaticAccessAllowedSql('s', { free: true, planAlias: 'p' })}
        AND NOT EXISTS(
          SELECT 1
          FROM jellyfin_accounts ja
          JOIN jellyfin_servers js ON js.id=ja.server_id
          WHERE ja.customer_id=s.customer_id
            AND ja.account_purpose='jellyfin'
            AND ja.access_lane='free'
            AND ja.disabled=FALSE
            AND js.enabled=TRUE
            AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
            AND ${mediaAssignmentMatchesSql('s','ja')}
        )
      ORDER BY s.created_at
      LIMIT $1
    `, [bounded]),
    query(`
      SELECT h.id,h.customer_id,s.id AS subscription_id,h.reason,
             NULLIF(h.metadata->>'error','') AS restore_error,h.created_at
      FROM customer_access_holds h
      JOIN subscriptions s
        ON s.customer_id=h.customer_id
       AND h.metadata->>'subscriptionId'=s.id::text
      JOIN plans p ON p.id=s.plan_id
      WHERE h.hold_type='inactivity_policy'
        AND h.released_at IS NULL
        AND COALESCE(h.metadata,'{}'::jsonb) @> '{"restoreReconcileFailed":true}'::jsonb
        AND h.source_key=('plan:'||p.id::text)
        ${freeLive}
        AND NOT public.subscription_admin_removed(s.customer_id,'jellyfin')
        AND NOT public.subscription_admin_present(s.customer_id,'jellyfin',s.id)
        AND NOT EXISTS(
          SELECT 1
          FROM customer_entitlement_overrides restore_override
          WHERE restore_override.customer_id=s.customer_id
            AND restore_override.subscription_id=s.id
            AND restore_override.permanent_access=TRUE
            AND restore_override.revoked_at IS NULL
        )
        AND NOT EXISTS(
          SELECT 1
          FROM jellyfin_accounts ja
          JOIN jellyfin_servers js ON js.id=ja.server_id
          WHERE ja.customer_id=s.customer_id
            AND ja.account_purpose='jellyfin'
            AND ja.access_lane='free'
            AND ja.disabled=FALSE
            AND js.enabled=TRUE
            AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
            AND ${mediaAssignmentMatchesSql('s','ja')}
        )
      ORDER BY h.created_at
      LIMIT $1
    `, [bounded]),
    query(`
      SELECT ja.id,ja.customer_id,ja.server_id,ja.disabled
      FROM jellyfin_accounts ja
      JOIN jellyfin_servers js ON js.id=ja.server_id
      WHERE ja.account_purpose='jellyfin'
        AND ja.access_lane='free'
        AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
        AND NOT EXISTS(
          SELECT 1
          FROM subscriptions s
          JOIN plans p ON p.id=s.plan_id
          WHERE s.customer_id=ja.customer_id
            ${freeLive}
        )
      ORDER BY ja.created_at
      LIMIT $1
    `, [bounded]),
    query(`
      SELECT s.id AS subscription_id,s.customer_id,p.code AS plan_code,s.created_at
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      WHERE TRUE ${primaryLive}
        AND COALESCE(NULLIF(s.billing_interval_snapshot,''),p.billing_interval)='trial'
        AND NOT public.subscription_admin_removed(s.customer_id,'jellyfin')
        AND ${automaticAccessAllowedSql('s')}
        AND NOT EXISTS(
          SELECT 1
          FROM jellyfin_accounts ja
          JOIN jellyfin_servers js ON js.id=ja.server_id
          WHERE ja.customer_id=s.customer_id
            AND ja.account_purpose='jellyfin'
            AND COALESCE(ja.access_lane,'primary')='primary'
            AND ja.disabled=FALSE
            AND js.enabled=TRUE
            AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
            AND ${mediaAssignmentMatchesSql('s','ja')}
        )
      ORDER BY s.created_at
      LIMIT $1
    `, [bounded]),
    query(`
      SELECT ja.id,ja.customer_id,ja.server_id,ja.disabled
      FROM jellyfin_accounts ja
      JOIN jellyfin_servers js ON js.id=ja.server_id
      WHERE ja.account_purpose='jellyfin'
        AND COALESCE(ja.access_lane,'primary')='primary'
        AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
        AND NOT EXISTS(
          SELECT 1
          FROM subscriptions s
          JOIN plans p ON p.id=s.plan_id
          WHERE s.customer_id=ja.customer_id
            ${primaryLive}
        )
      ORDER BY ja.created_at
      LIMIT $1
    `, [bounded]),
    query(`
      SELECT s.id AS subscription_id,s.customer_id,p.code AS plan_code,s.created_at
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      LEFT JOIN customer_provisioning_state cps ON cps.customer_id=s.customer_id
      WHERE TRUE ${primaryLive}
        AND COALESCE(NULLIF(s.billing_interval_snapshot,''),p.billing_interval)<>'trial'
        AND COALESCE(s.price_minor_snapshot,p.price_minor,0)>0
        AND NOT public.subscription_admin_removed(s.customer_id,'jellyfin')
        AND ${automaticAccessAllowedSql('s')}
        AND NOT EXISTS(
          SELECT 1
          FROM jellyfin_accounts ja
          JOIN jellyfin_servers js ON js.id=ja.server_id
          WHERE ja.customer_id=s.customer_id
            AND ja.account_purpose='jellyfin'
            AND COALESCE(ja.access_lane,'primary')='primary'
            AND ja.disabled=FALSE
            AND js.enabled=TRUE
            AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
            AND ${mediaAssignmentMatchesSql('s','ja')}
        )
        AND COALESCE(cps.status,'') NOT IN('pending','running','failed','blocked')
      ORDER BY s.created_at
      LIMIT $1
    `, [bounded]),
    query(`
      WITH effective AS (
        SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
        UNION ALL
        SELECT a.customer_id,a.subscription_id,a.access_expires_at,
               public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
        FROM effective_customer_addons a
        JOIN subscriptions s ON s.id=a.subscription_id
      )
      SELECT ee.subscription_id,ee.customer_id,e.id AS entitlement_id,e.status,e.token_hash
      FROM effective ee
      LEFT JOIN stremio_entitlements e
        ON e.customer_id=ee.customer_id AND e.subscription_id=ee.subscription_id
      WHERE ee.blocked=FALSE AND ee.access_expires_at>NOW()
        AND (e.id IS NULL OR e.status<>'active' OR e.token_hash IS NULL)
      ORDER BY ee.access_expires_at
      LIMIT $1
    `, [bounded]),
    query(`
      WITH effective AS (
        SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
        UNION ALL
        SELECT a.customer_id,a.subscription_id,a.access_expires_at,
               public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
        FROM effective_customer_addons a
        JOIN subscriptions s ON s.id=a.subscription_id
      )
      SELECT e.id,e.customer_id,e.subscription_id,e.token_version,e.token_hint
      FROM effective ee
      JOIN stremio_entitlements e
        ON e.customer_id=ee.customer_id AND e.subscription_id=ee.subscription_id
      LEFT JOIN stremio_install_credential_recovery r
        ON r.customer_id=e.customer_id AND r.entitlement_id=e.id
       AND r.token_version=e.token_version
       AND COALESCE(r.token_hint,'')=COALESCE(e.token_hint,'')
      WHERE ee.blocked=FALSE AND ee.access_expires_at>NOW()
        AND e.status='active' AND e.token_hash IS NOT NULL
        AND r.customer_id IS NULL
      ORDER BY e.updated_at
      LIMIT $1
    `, [bounded]),
    query(`
      WITH effective AS (
        SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
        UNION ALL
        SELECT a.customer_id,a.subscription_id,a.access_expires_at,
               public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
        FROM effective_customer_addons a
        JOIN subscriptions s ON s.id=a.subscription_id
      )
      SELECT e.id,e.customer_id,e.subscription_id,e.updated_at
      FROM stremio_entitlements e
      WHERE e.status='active'
        AND NOT EXISTS(
          SELECT 1 FROM effective ee
          WHERE ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id
            AND ee.blocked=FALSE AND ee.access_expires_at>NOW()
        )
      ORDER BY e.updated_at
      LIMIT $1
    `, [bounded]),
    query(`
      SELECT s.id,s.name,COUNT(DISTINCT ps.plan_id)::int AS mapped_plans
      FROM stremio_sources s
      JOIN plan_stremio_sources ps ON ps.source_id=s.id AND ps.enabled=TRUE
      JOIN stremio_source_index_state i ON i.source_id=s.id
      WHERE s.enabled=TRUE AND s.auth_state='connected'
        AND s.password_encrypted IS NULL
        AND i.last_completed_at IS NOT NULL AND i.item_count>0
      GROUP BY s.id,s.name
      ORDER BY s.name
      LIMIT $1
    `, [bounded]),
    query(`
      SELECT i.source_id AS id,s.name,i.item_count,
             COUNT(m.item_id)::int AS serving_count
      FROM stremio_source_index_state i
      JOIN stremio_sources s ON s.id=i.source_id
      LEFT JOIN stremio_source_media_index m ON m.source_id=i.source_id
      WHERE i.last_completed_at IS NOT NULL
      GROUP BY i.source_id,s.name,i.item_count
      HAVING i.item_count<>COUNT(m.item_id)::int
      ORDER BY s.name
      LIMIT $1
    `, [bounded]),
    query(`
      SELECT i.server_id AS id,js.name,i.item_count,
             COUNT(m.item_id)::int AS serving_count
      FROM stremio_media_index_state i
      JOIN jellyfin_servers js ON js.id=i.server_id
      LEFT JOIN stremio_media_index m ON m.server_id=i.server_id
      WHERE i.last_completed_at IS NOT NULL
      GROUP BY i.server_id,js.name,i.item_count
      HAVING i.item_count<>COUNT(m.item_id)::int
      ORDER BY js.name
      LIMIT $1
    `, [bounded])
  ]);

  const findings = [];
  for (const row of freePlanWithoutServer.rows) {
    findings.push(finding(
      'free_plan_without_ready_server',
      row,
      `Live Free subscription ${row.subscription_id} has no enabled Free-lane Jellyfin account. Free access must converge to plan+server or no-plan+no-server.`
    ));
  }
  for (const row of failedFreeRestores.rows) {
    findings.push(finding(
      'free_restore_reprovision_failed',
      row,
      `Free Server restore for subscription ${row.subscription_id} remains fail-closed after reprovisioning failed${row.restore_error ? `: ${row.restore_error}` : '.'}`
    ));
  }
  for (const row of freeServerWithoutPlan.rows) {
    findings.push(finding(
      'free_server_without_plan',
      row,
      `Free-lane Jellyfin account ${row.id} exists without a live Free entitlement and should be removed by reconciliation.`
    ));
  }
  for (const row of unpaidTrialWithoutServer.rows) {
    findings.push(finding(
      'unpaid_trial_without_ready_server',
      row,
      `Unpaid Jellyfin trial ${row.subscription_id} has no enabled primary Jellyfin account and should be rolled back.`
    ));
  }
  for (const row of primaryServerWithoutPlan.rows) {
    findings.push(finding(
      'primary_server_without_plan',
      row,
      `Primary Jellyfin account ${row.id} exists without a live non-Free Jellyfin entitlement.`
    ));
  }
  for (const row of paidPlanWithoutRecovery.rows) {
    findings.push(finding(
      'paid_plan_without_recovery_state',
      row,
      `Paid Jellyfin subscription ${row.subscription_id} has no enabled primary account and no provisioning recovery state. Paid entitlement may be retained, but retry state must exist.`
    ));
  }
  for (const row of stremioMissingInstallCredential.rows) {
    findings.push(finding(
      'stremio_entitlement_without_install_link',
      row,
      `Live Stremio subscription ${row.subscription_id} is missing an active install credential. Entitlement reconciliation must converge to active entitlement + private installation link.`
    ));
  }
  for (const row of stremioMissingRecoverableLink.rows) {
    findings.push(finding(
      'stremio_install_link_not_recoverable',
      row,
      `Active Stremio entitlement ${row.id} has a published install token but no matching encrypted recovery copy for token version ${row.token_version}. My Access cannot redisplay the canonical link without self-healing.`
    ));
  }
  for (const row of staleActiveStremioEntitlement.rows) {
    findings.push(finding(
      'stremio_active_without_effective_subscription',
      row,
      `Stremio entitlement ${row.id} is still active even though subscription ${row.subscription_id} is no longer an effective unblocked Stremio entitlement.`
    ));
  }
  for (const row of externalStremioPlaybackCredentialGap.rows) {
    findings.push(finding(
      'stremio_external_source_not_playback_ready',
      row,
      `External Stremio source ${row.name} is mapped to ${row.mapped_plans} plan(s) and has a serving index, but no encrypted password is available to mint isolated playback sessions. Reconnect the source before relying on it for customer results.`
    ));
  }
  for (const row of externalStremioIndexCountDrift.rows) {
    findings.push(finding(
      'stremio_external_index_count_drift',
      row,
      `External Stremio source ${row.name} reports ${row.item_count} serving item(s) but the live index contains ${row.serving_count}.`
    ));
  }
  for (const row of managedStremioIndexCountDrift.rows) {
    findings.push(finding(
      'stremio_managed_index_count_drift',
      row,
      `Managed Stremio server ${row.name} reports ${row.item_count} serving item(s) but the live index contains ${row.serving_count}.`
    ));
  }
  return findings;
}

module.exports = {
  clean,
  finding,
  freeScopedAccessBlockedSql,
  automaticAccessAllowedSql,
  mediaAssignmentMatchesSql,
  liveEntitlementSql,
  scan
};
