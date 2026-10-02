'use strict';

const { transaction } = require('../db');
const planPricing = require('../payments/plan-pricing');
const planContract = require('./plan-contract');

async function createPlan(plan, actorUserId = null) {
  planContract.validateCreatePlan(plan);
  return transaction(async client => {
    const nextOrder = Number((await client.query(
      'SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM plans'
    )).rows[0]?.n || 10);

    const result = await client.query(
      `INSERT INTO plans(code,name,description,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,is_addon,server_class,visible,active,sort_order,jellyfin_access_model,jellyfin_household_network_limit,jellyfin_household_lease_minutes,stremio_household_network_limit,stremio_household_lease_minutes,stremio_ip_replacement_policy,stremio_ip_replacement_cooldown_minutes,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,allow_subtitle_editing,library_access_mode,library_names,inactivity_policy)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34::text[],$35::jsonb) RETURNING *`,
      [
        plan.code, plan.name, plan.description, plan.serviceType, plan.audience,
        plan.billing, plan.duration, plan.priceMinor, plan.currency, plan.capacityLimit,
        plan.isAddon, plan.serverClass, plan.visible, plan.active, nextOrder,
        plan.jellyfinAccessModel, plan.jellyfinHouseholdNetworkLimit,
        plan.jellyfinHouseholdLeaseMinutes, plan.stremioHouseholdNetworkLimit,
        plan.stremioHouseholdLeaseMinutes, plan.stremioIpReplacementPolicy,
        plan.stremioIpReplacementCooldownMinutes, plan.streams, plan.downloads,
        plan.video, plan.audio, plan.remux, plan.live, plan.liveManagement,
        plan.remote, plan.fourk, plan.subtitles, plan.libraryMode, plan.libraries,
        JSON.stringify(plan.inactivityPolicy)
      ]
    );

    const created = result.rows[0];
    await planPricing.setPrice(client, created.id, {
      currency: plan.currency,
      priceMinor: plan.priceMinor,
      active: true,
      isDefault: true
    });

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.create','plan',$2,$3::jsonb)`,
      [
        actorUserId,
        created.id,
        JSON.stringify({
          code: plan.code,
          planKind: plan.planKind,
          serviceType: plan.serviceType,
          audience: 'direct',
          currency: plan.currency,
          priceMinor: plan.priceMinor,
          capacityLimit: plan.capacityLimit,
          jellyfinAccessModel: plan.jellyfinAccessModel,
          streams: plan.streams,
          jellyfinHouseholdNetworkLimit: plan.jellyfinHouseholdNetworkLimit,
          jellyfinHouseholdLeaseMinutes: plan.jellyfinHouseholdLeaseMinutes,
          stremioHouseholdNetworkLimit: plan.stremioHouseholdNetworkLimit,
          stremioHouseholdLeaseMinutes: plan.stremioHouseholdLeaseMinutes,
          stremioIpReplacementPolicy: plan.stremioIpReplacementPolicy,
          stremioIpReplacementCooldownMinutes: plan.stremioIpReplacementCooldownMinutes,
          jellyfinPolicy: {
            downloads: plan.downloads,
            videoTranscoding: plan.video,
            audioTranscoding: plan.audio,
            remuxing: plan.remux,
            liveTv: plan.live,
            liveTvManagement: plan.liveManagement,
            remoteAccess: plan.remote,
            allow4k: plan.fourk,
            subtitleEditing: plan.subtitles,
            libraryAccessMode: plan.libraryMode,
            libraryNames: plan.libraries
          },
          inactivityPolicy: plan.inactivityPolicy
        })
      ]
    );

    return created;
  });
}

async function updateProduct({
  planId,
  name,
  description,
  features = [],
  visible,
  active,
  discordRoleId = null,
  actorUserId = null,
  auditMetadata = {}
}) {
  planContract.validateProduct({ name, description, features, visible, active });
  return transaction(async client => {
    const updated = await client.query(
      `UPDATE plans
       SET name=$2,description=$3,marketing_features=$4::text[],visible=$5,active=$6,discord_role_id=$7,updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [planId, name, description, features, visible, active, discordRoleId]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.product.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify(auditMetadata)]
    );
    return updated.rows[0];
  });
}

async function updateAvailability({ planId, capacityLimit, actorUserId = null }) {
  planContract.validateAvailability({ capacityLimit });
  return transaction(async client => {
    const updated = await client.query(
      'UPDATE plans SET capacity_limit=$2,updated_at=NOW() WHERE id=$1 RETURNING *',
      [planId, capacityLimit]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.inventory.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({ capacityLimit })]
    );
    return updated.rows[0];
  });
}

async function updateDelivery({
  planId,
  serverClass,
  strategy,
  poolMode,
  servers = [],
  actorUserId = null,
  auditMetadata = {}
}) {
  return transaction(async client => {
    const updated = await client.query(
      'UPDATE plans SET server_class=$2,placement_strategy=$3,updated_at=NOW() WHERE id=$1 RETURNING *',
      [planId, serverClass, strategy]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');
    await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [planId]);
    if (poolMode === 'selected') {
      for (const server of servers) {
        await client.query(
          'INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,$3)',
          [planId, server.id, server.weight]
        );
      }
    }
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.server_placement','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify(auditMetadata)]
    );
    return updated.rows[0];
  });
}

async function updateLibraries({
  planId,
  mode,
  names = [],
  actorUserId = null,
  auditMetadata = {}
}) {
  planContract.validateLibraries({ mode, names });
  return transaction(async client => {
    const updated = await client.query(
      'UPDATE plans SET library_access_mode=$2,library_names=$3::text[],updated_at=NOW() WHERE id=$1 RETURNING *',
      [planId, mode, mode === 'all' ? [] : names]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.library_access','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify(auditMetadata)]
    );
    return updated.rows[0];
  });
}

async function updateCommerce({
  planId,
  currentBillingInterval,
  billingInterval,
  durationDays,
  currency,
  priceMinor,
  actorUserId = null
}) {
  planContract.validateCommerce({ billingInterval, durationDays, currency, priceMinor });
  const before = await planPricing.resolvePrice(planId, currency, { allowFallback: false });
  const pricingChanged = !before || Number(before.price_minor) !== Number(priceMinor);
  const intervalChanged = String(currentBillingInterval || '') !== String(billingInterval || '');

  return transaction(async client => {
    const updated = await client.query(
      'UPDATE plans SET billing_interval=$2,duration_days=$3,updated_at=NOW() WHERE id=$1 RETURNING *',
      [planId, billingInterval, durationDays]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');
    const price = await planPricing.setPrice(client, planId, {
      currency,
      priceMinor,
      active: true,
      isDefault: true
    });
    if (pricingChanged || intervalChanged) {
      await client.query(
        `UPDATE plan_provider_prices
         SET active=FALSE,
             verification_status='unverified',
             verification_error='Plan commercial schedule changed; re-verification required.',
             updated_at=NOW()
         WHERE plan_price_id=$1`,
        [price.id]
      );
    }
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.commerce.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({
        currency,
        priceMinor,
        billingInterval,
        durationDays
      })]
    );
    return {
      plan: updated.rows[0],
      price,
      pricingChanged,
      intervalChanged
    };
  });
}

async function saveProviderOption(client, {
  planId,
  priceId,
  priceMinor,
  currency,
  provider,
  mode,
  enabled,
  externalId = null,
  verification = null
}) {
  if (!enabled) {
    await client.query(
      'DELETE FROM plan_provider_prices WHERE plan_price_id=$1 AND provider=$2 AND checkout_mode=$3',
      [priceId, provider, mode]
    );
    return;
  }

  planContract.validateProviderMapping({ provider, mode, externalId });

  if (mode === 'subscription' && !externalId) {
    throw new Error(`${provider === 'stripe' ? 'Stripe' : 'PayPal'} subscription ID is required.`);
  }

  const v = verification || {
    verificationStatus: 'not_required',
    verifiedAt: new Date(),
    verificationError: null,
    remoteAmountMinor: priceMinor,
    remoteCurrency: currency,
    remoteInterval: null,
    remoteActive: true
  };

  await client.query(
    `INSERT INTO plan_provider_prices(
       plan_id,plan_price_id,provider,external_id,checkout_mode,active,
       verified_at,verification_status,verification_error,
       remote_amount_minor,remote_currency,remote_interval,remote_active
     ) VALUES($1,$2,$3,$4,$5,TRUE,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT(plan_price_id,provider,checkout_mode)
     DO UPDATE SET
       plan_id=EXCLUDED.plan_id,
       external_id=EXCLUDED.external_id,
       active=TRUE,
       verified_at=EXCLUDED.verified_at,
       verification_status=EXCLUDED.verification_status,
       verification_error=EXCLUDED.verification_error,
       remote_amount_minor=EXCLUDED.remote_amount_minor,
       remote_currency=EXCLUDED.remote_currency,
       remote_interval=EXCLUDED.remote_interval,
       remote_active=EXCLUDED.remote_active,
       updated_at=NOW()`,
    [
      planId,
      priceId,
      provider,
      externalId || null,
      mode,
      v.verifiedAt,
      v.verificationStatus,
      v.verificationError,
      v.remoteAmountMinor,
      v.remoteCurrency,
      v.remoteInterval,
      v.remoteActive
    ]
  );
}

async function updatePaymentOptions({
  planId,
  price,
  items = [],
  actorUserId = null,
  auditAction = 'admin.plan.payment_options',
  auditMetadata = {}
}) {
  if (!price?.id) throw new Error('A plan price is required before payment options can be saved.');

  return transaction(async client => {
    for (const item of items) {
      await saveProviderOption(client, {
        planId,
        priceId: price.id,
        priceMinor: price.price_minor,
        currency: price.currency,
        provider: item.provider,
        mode: item.mode,
        enabled: item.enabled,
        externalId: item.externalId,
        verification: item.verification
      });
    }

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,$2,'plan',$3,$4::jsonb)`,
      [actorUserId, auditAction, planId, JSON.stringify(auditMetadata)]
    );
  });
}

async function updatePortalCurrencyPrice({
  planId,
  currency,
  priceMinor,
  freeTier = false,
  actorUserId = null
}) {
  const before = await planPricing.resolvePrice(planId, currency, { allowFallback: false });
  return transaction(async client => {
    const changed = Boolean(before) && Number(before.price_minor) !== Number(priceMinor);
    const price = await planPricing.setPrice(client, planId, {
      currency,
      priceMinor,
      active: true,
      isDefault: true
    });

    if (changed) {
      await client.query(
        `UPDATE plan_provider_prices
         SET active=FALSE,
             verification_status='unverified',
             verification_error='Plan price changed; re-verification required.',
             updated_at=NOW()
         WHERE plan_price_id=$1`,
        [price.id]
      );
    }

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.portal_currency_price.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({ currency, priceMinor, freeTier: Boolean(freeTier) })]
    );

    return { price, changed };
  });
}

async function planSubscriberCount(client, planId) {
  const result = await client.query(
    `SELECT COUNT(DISTINCT customer_id)::int count FROM subscriptions
     WHERE plan_id=$1 AND superseded_by IS NULL
       AND status IN ('active','trialing','past_due','paused')
       AND starts_at<=NOW() AND current_period_end>NOW()`,
    [planId]
  );
  return Number(result.rows[0]?.count || 0);
}

async function clearPlanLeases(client, planId) {
  return client.query(
    `DELETE FROM access_network_leases
     WHERE subject_key IN (SELECT id::text FROM subscriptions WHERE plan_id=$1)
       AND scope IN ('jellyfin','stremio')`,
    [planId]
  );
}

async function updateAccessPolicy({
  planId,
  input,
  actorUserId = null
}) {
  if (!input || typeof input !== 'object') throw new Error('Plan access policy input is required.');

  return transaction(async client => {
    const activeSubscribers = await planSubscriberCount(client, planId);
    const updated = await client.query(
      `UPDATE plans SET
         jellyfin_access_model=$2,jellyfin_household_network_limit=$3,jellyfin_household_lease_minutes=$4,
         stremio_household_lease_minutes=$5,streams=$6,
         allow_downloads=$7,allow_video_transcoding=$8,allow_audio_transcoding=$9,allow_remuxing=$10,
         allow_live_tv=$11,allow_live_tv_management=$12,allow_remote_access=$13,allow_4k=$14,
         allow_subtitle_editing=$15,updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [
        planId,
        input.accessModel,
        input.jellyfinHouseholdNetworkLimit,
        input.jellyfinHouseholdLeaseMinutes,
        input.stremioHouseholdLeaseMinutes,
        input.streams,
        input.allowDownloads,
        input.allowVideoTranscoding,
        input.allowAudioTranscoding,
        input.allowRemuxing,
        input.allowLiveTv,
        input.allowLiveTvManagement,
        input.allowRemoteAccess,
        input.allow4k,
        input.allowSubtitleEditing
      ]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    await clearPlanLeases(client, planId);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.access_policy.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({ ...input, activeSubscribers })]
    );

    return { plan: updated.rows[0], activeSubscribers };
  });
}

async function updateStremioCommerce({
  planId,
  name,
  description,
  features = [],
  billingInterval,
  durationDays,
  discordRoleId = null,
  currency,
  priceMinor,
  actorUserId = null,
  auditMetadata = {}
}) {
  return transaction(async client => {
    const updated = await client.query(
      `UPDATE plans SET
         name=$2,description=$3,marketing_features=$4::text[],
         billing_interval=$5,duration_days=$6,discord_role_id=$7,updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [planId, name, description, features, billingInterval, durationDays, discordRoleId]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    const price = await planPricing.setPrice(client, planId, {
      currency,
      priceMinor,
      active: true,
      isDefault: true
    });

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.stremio_commerce.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify(auditMetadata)]
    );

    return { plan: updated.rows[0], price };
  });
}

async function updateStremioStorefront({
  planId,
  description,
  features = [],
  actorUserId = null
}) {
  return transaction(async client => {
    const updated = await client.query(
      `UPDATE plans
       SET description=$2,marketing_features=$3::text[],updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [planId, description, features]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.stremio_storefront_compat.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({ features: features.length })]
    );

    return updated.rows[0];
  });
}

async function updateStremioTrackingSnapshots(client, {
  planId,
  householdLimit,
  refresh
}) {
  if (!refresh) return 0;

  const result = await client.query(
    `UPDATE subscriptions
     SET stremio_household_network_limit_snapshot=$2,
         stremio_ip_replacement_policy_snapshot='auto_inactive'
     WHERE plan_id=$1
       AND superseded_by IS NULL
       AND status IN ('active','trialing','past_due','paused')
       AND starts_at<=NOW()
       AND current_period_end>NOW()
     RETURNING id`,
    [planId, householdLimit]
  );

  const ids = result.rows.map(row => String(row.id));
  if (ids.length) {
    await client.query(
      `UPDATE access_network_leases
       SET expires_at=NOW()
       WHERE scope='stremio'
         AND subject_key=ANY($1::text[])
         AND expires_at>NOW()`,
      [ids]
    );
  }
  return ids.length;
}

async function updateStremioAccess({
  planId,
  householdLimit,
  leaseMinutes,
  refreshTracking = false,
  impact = {},
  actorUserId = null
}) {
  planContract.validateStremioAccess({ householdLimit, leaseMinutes });
  return transaction(async client => {
    const updatedSubscriptions = await updateStremioTrackingSnapshots(client, {
      planId,
      householdLimit,
      refresh: refreshTracking
    });

    const updated = await client.query(
      `UPDATE plans
       SET stremio_household_network_limit=$2,
           stremio_household_lease_minutes=$3,
           stremio_ip_replacement_policy='auto_inactive',
           updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [planId, householdLimit, leaseMinutes]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.stremio_access.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({
        householdImpact: impact,
        replacementPolicy: 'auto_inactive',
        updatedSubscriptions
      })]
    );

    return { plan: updated.rows[0], updatedSubscriptions };
  });
}

async function updateStremioAvailability({
  planId,
  capacityLimit,
  active,
  visible,
  actorUserId = null
}) {
  planContract.validateAvailability({ capacityLimit, active, visible });
  return transaction(async client => {
    const updated = await client.query(
      `UPDATE plans
       SET capacity_limit=$2,active=$3,visible=$4,updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [planId, capacityLimit, active, visible]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.stremio_availability.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({ capacityLimit, active, visible })]
    );

    return updated.rows[0];
  });
}

async function upsertEmbyPlan({
  input,
  plan = null,
  selectedServers = [],
  actorUserId = null,
  currency
}) {
  if (!input || typeof input !== 'object') throw new Error('Emby plan input is required.');
  const before = plan
    ? await planPricing.resolvePrice(plan.id, currency, { allowFallback: false })
    : null;
  const commercialChanged = plan
    ? !before || Number(before.price_minor) !== Number(input.priceMinor) || String(plan.billing_interval) !== String(input.billing)
    : false;

  return transaction(async client => {
    let row;
    if (plan) {
      const result = await client.query(
        `UPDATE plans SET
           name=$2,description=$3,billing_interval=$4,duration_days=$5,capacity_limit=$6,
           server_class=$7,visible=$8,active=$9,jellyfin_access_model=$10,streams=$11,
           jellyfin_household_network_limit=$12,jellyfin_household_lease_minutes=$13,
           allow_downloads=$14,allow_video_transcoding=$15,allow_audio_transcoding=$16,
           allow_remuxing=$17,allow_live_tv=$18,allow_live_tv_management=$19,
           allow_remote_access=$20,allow_4k=$21,allow_subtitle_editing=$22,
           library_access_mode=$23,library_names=$24::text[],marketing_features=$25::text[],
           placement_strategy=$26,updated_at=NOW()
         WHERE id=$1 AND service_type='emby'
         RETURNING *`,
        [
          plan.id, input.name, input.description, input.billing, input.duration,
          input.capacityLimit, input.serverClass, input.visible, input.active,
          input.accessModel, input.streams, input.networkLimit, input.leaseMinutes,
          input.downloads, input.video, input.audio, input.remux, input.live,
          input.liveManagement, input.remote, input.fourk, input.subtitles,
          input.libraryMode, input.libraryMode === 'all' ? [] : input.libraries,
          input.marketing, input.placementStrategy
        ]
      );
      if (!result.rowCount) throw new Error('Emby Share plan not found.');
      row = result.rows[0];

      const price = await planPricing.setPrice(client, plan.id, {
        currency,
        priceMinor: input.priceMinor,
        active: true,
        isDefault: true
      });
      if (commercialChanged) {
        await client.query(
          `UPDATE plan_provider_prices
           SET active=FALSE,
               verification_status='unverified',
               verification_error='Plan commercial schedule changed; re-verification required.',
               updated_at=NOW()
           WHERE plan_price_id=$1`,
          [price.id]
        );
      }
    } else {
      const nextOrder = Number((await client.query(
        'SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM plans'
      )).rows[0]?.n || 10);
      const result = await client.query(
        `INSERT INTO plans(
           code,name,description,service_type,audience,billing_interval,duration_days,
           price_minor,currency,capacity_limit,is_addon,server_class,visible,active,sort_order,
           jellyfin_access_model,jellyfin_household_network_limit,jellyfin_household_lease_minutes,
           streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,
           allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,allow_subtitle_editing,
           library_access_mode,library_names,marketing_features,placement_strategy,is_free_tier
         ) VALUES(
           $1,$2,$3,'emby','direct',$4,$5,$6,$7,$8,FALSE,$9,$10,$11,$12,$13,$14,$15,
           $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::text[],$28::text[],$29,FALSE
         )
         RETURNING *`,
        [
          input.code, input.name, input.description, input.billing, input.duration,
          input.priceMinor, currency, input.capacityLimit, input.serverClass,
          input.visible, input.active, nextOrder, input.accessModel, input.networkLimit,
          input.leaseMinutes, input.streams, input.downloads, input.video, input.audio,
          input.remux, input.live, input.liveManagement, input.remote, input.fourk,
          input.subtitles, input.libraryMode, input.libraryMode === 'all' ? [] : input.libraries,
          input.marketing, input.placementStrategy
        ]
      );
      row = result.rows[0];
      await planPricing.setPrice(client, row.id, {
        currency,
        priceMinor: input.priceMinor,
        active: true,
        isDefault: true
      });
    }

    await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [row.id]);
    if (input.poolMode === 'selected') {
      for (const server of selectedServers) {
        await client.query(
          'INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,$3)',
          [row.id, server.id, server.weight]
        );
      }
    }

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,$2,'plan',$3,$4::jsonb)`,
      [
        actorUserId,
        plan ? 'admin.emby_plan.update' : 'admin.emby_plan.create',
        row.id,
        JSON.stringify({
          serviceType: 'emby',
          currency,
          priceMinor: input.priceMinor,
          capacityLimit: input.capacityLimit,
          serverClass: input.serverClass,
          poolMode: input.poolMode,
          servers: selectedServers,
          streams: input.streams
        })
      ]
    );

    return row;
  });
}

async function saveImportedLegacyPlan(client, plan) {
  planContract.validateImportedPlan(plan);
  const existing = await client.query('SELECT id FROM plans WHERE code=$1 FOR UPDATE', [plan.code]);
  if (existing.rowCount) {
    return client.query(
      `UPDATE plans SET
         name=$2,description=$3,audience=$4,billing_interval=$5,duration_days=$6,
         price_minor=$7,currency=$8,
         streams=CASE WHEN jellyfin_access_model='household_network' THEN NULL ELSE COALESCE($9,1) END,
         allow_downloads=$10,allow_video_transcoding=$11,allow_audio_transcoding=$12,
         allow_live_tv=$13,allow_live_tv_management=$14,allow_4k=$15,allow_remuxing=$16,
         allow_remote_access=$17,server_class=$18,active=$19,visible=$20,sort_order=$21,
         library_access_mode=$22,library_names=$23::text[],placement_strategy=$24,updated_at=NOW()
       WHERE id=$1
       RETURNING id`,
      [
        existing.rows[0].id, plan.name, plan.description, plan.audience,
        plan.billing_interval, plan.duration_days, plan.price_minor, plan.currency,
        plan.streams, plan.allow_downloads, plan.allow_video_transcoding,
        plan.allow_audio_transcoding, plan.allow_live_tv, plan.allow_live_tv_management,
        plan.allow_4k, plan.allow_remuxing, plan.allow_remote_access, plan.server_class,
        plan.active, plan.visible, plan.sort_order, plan.library_access_mode,
        plan.library_names, plan.placement_strategy
      ]
    );
  }

  const safeStreams = plan.streams == null ? 1 : plan.streams;
  return client.query(
    `INSERT INTO plans(
       code,name,description,audience,billing_interval,duration_days,price_minor,currency,
       streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,
       allow_live_tv,allow_live_tv_management,allow_4k,allow_remuxing,allow_remote_access,
       server_class,active,visible,sort_order,library_access_mode,library_names,
       placement_strategy,created_at,updated_at
     ) VALUES(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
       $22,$23::text[],$24,NOW(),NOW()
     )
     RETURNING id`,
    [
      plan.code, plan.name, plan.description, plan.audience, plan.billing_interval,
      plan.duration_days, plan.price_minor, plan.currency, safeStreams,
      plan.allow_downloads, plan.allow_video_transcoding, plan.allow_audio_transcoding,
      plan.allow_live_tv, plan.allow_live_tv_management, plan.allow_4k,
      plan.allow_remuxing, plan.allow_remote_access, plan.server_class, plan.active,
      plan.visible, plan.sort_order, plan.library_access_mode, plan.library_names,
      plan.placement_strategy
    ]
  );
}

async function saveImportedV2Plan(client, plan) {
  planContract.validateImportedPlan(plan);
  return client.query(
    `INSERT INTO plans(
       code,name,description,service_type,audience,billing_interval,duration_days,
       price_minor,currency,capacity_limit,is_addon,streams,allow_downloads,
       allow_video_transcoding,allow_audio_transcoding,allow_live_tv,
       allow_live_tv_management,allow_4k,allow_remuxing,allow_remote_access,
       server_class,active,visible,sort_order,library_access_mode,library_names,
       placement_strategy,jellyfin_access_model,jellyfin_household_network_limit,
       jellyfin_household_lease_minutes,stremio_household_lease_minutes,created_at,updated_at
     ) VALUES(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,$26::text[],$27,$28,$29,$30,$31,NOW(),NOW()
     )
     ON CONFLICT(code) DO UPDATE SET
       name=EXCLUDED.name,description=EXCLUDED.description,service_type=EXCLUDED.service_type,
       audience=EXCLUDED.audience,billing_interval=EXCLUDED.billing_interval,
       duration_days=EXCLUDED.duration_days,price_minor=EXCLUDED.price_minor,
       currency=EXCLUDED.currency,capacity_limit=EXCLUDED.capacity_limit,
       is_addon=EXCLUDED.is_addon,streams=EXCLUDED.streams,
       allow_downloads=EXCLUDED.allow_downloads,
       allow_video_transcoding=EXCLUDED.allow_video_transcoding,
       allow_audio_transcoding=EXCLUDED.allow_audio_transcoding,
       allow_live_tv=EXCLUDED.allow_live_tv,
       allow_live_tv_management=EXCLUDED.allow_live_tv_management,
       allow_4k=EXCLUDED.allow_4k,allow_remuxing=EXCLUDED.allow_remuxing,
       allow_remote_access=EXCLUDED.allow_remote_access,server_class=EXCLUDED.server_class,
       active=EXCLUDED.active,visible=EXCLUDED.visible,sort_order=EXCLUDED.sort_order,
       library_access_mode=EXCLUDED.library_access_mode,library_names=EXCLUDED.library_names,
       placement_strategy=EXCLUDED.placement_strategy,
       jellyfin_access_model=EXCLUDED.jellyfin_access_model,
       jellyfin_household_network_limit=EXCLUDED.jellyfin_household_network_limit,
       jellyfin_household_lease_minutes=EXCLUDED.jellyfin_household_lease_minutes,
       stremio_household_lease_minutes=EXCLUDED.stremio_household_lease_minutes,
       updated_at=NOW()
     RETURNING id`,
    [
      plan.code, plan.name, plan.description, plan.service_type, plan.audience,
      plan.billing_interval, plan.duration_days, plan.price_minor, plan.currency,
      plan.capacity_limit, plan.is_addon, plan.streams, plan.allow_downloads,
      plan.allow_video_transcoding, plan.allow_audio_transcoding, plan.allow_live_tv,
      plan.allow_live_tv_management, plan.allow_4k, plan.allow_remuxing,
      plan.allow_remote_access, plan.server_class, plan.active, plan.visible,
      plan.sort_order, plan.library_access_mode, plan.library_names,
      plan.placement_strategy, plan.jellyfin_access_model,
      plan.jellyfin_household_network_limit, plan.jellyfin_household_lease_minutes,
      plan.stremio_household_lease_minutes
    ]
  );
}

async function applyImportedPlans(client, plans, version = 1) {
  const serverRows = await client.query('SELECT id,slug FROM jellyfin_servers');
  const serverMap = new Map(serverRows.rows.map(row => [String(row.slug || '').toLowerCase(), row]));
  let poolsApplied = 0;
  let poolsSkipped = 0;

  for (const plan of plans || []) {
    const ownsModularContract = version === 2 && plan._modular_plan_contract !== false;
    const saved = ownsModularContract
      ? await saveImportedV2Plan(client, plan)
      : await saveImportedLegacyPlan(client, plan);
    const planId = saved.rows[0].id;

    if (Object.prototype.hasOwnProperty.call(plan, 'request_movie_quota_limit')) {
      await client.query(
        `UPDATE plans
         SET request_movie_quota_limit=$2,request_movie_quota_days=$3,
             request_tv_quota_limit=$4,request_tv_quota_days=$5,updated_at=NOW()
         WHERE id=$1`,
        [
          planId,
          plan.request_movie_quota_limit,
          plan.request_movie_quota_days,
          plan.request_tv_quota_limit,
          plan.request_tv_quota_days
        ]
      );
    }

    const pool = Array.isArray(plan.serverPool) ? plan.serverPool : [];
    const missing = pool.some(entry => !serverMap.has(String(entry.serverSlug || '').toLowerCase()));
    if (missing) {
      poolsSkipped += 1;
      continue;
    }

    await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [planId]);
    for (const entry of pool) {
      const server = serverMap.get(String(entry.serverSlug || '').toLowerCase());
      await client.query(
        `INSERT INTO plan_server_eligibility(plan_id,server_id,weight,created_at,updated_at)
         VALUES($1,$2,$3,NOW(),NOW())`,
        [planId, server.id, entry.weight]
      );
    }
    poolsApplied += 1;
  }

  return { poolsApplied, poolsSkipped };
}

async function applyImportedProviderMappings(client, mappings = []) {
  const planRows = await client.query('SELECT id,code FROM plans');
  const planByCode = new Map(planRows.rows.map(row => [String(row.code || '').toLowerCase(), row]));
  let directMappingsApplied = 0;
  let skippedReferences = 0;
  let mappingsPendingVerification = 0;

  for (const mapping of mappings) {
    const savedPlan = planByCode.get(String(mapping.planCode || '').toLowerCase());
    if (!savedPlan) {
      skippedReferences += 1;
      continue;
    }

    const metadata = {
      ...(mapping.metadata || {}),
      importedRequestedActive: Boolean(mapping.active),
      requiresRemoteVerification: true
    };
    await client.query(
      `INSERT INTO plan_provider_prices(
         plan_id,provider,external_id,checkout_mode,active,metadata
       ) VALUES($1,$2,$3,$4,FALSE,$5::jsonb)
       ON CONFLICT(plan_id,provider,checkout_mode)
       DO UPDATE SET
         external_id=EXCLUDED.external_id,
         active=FALSE,
         metadata=EXCLUDED.metadata,
         updated_at=NOW()`,
      [
        savedPlan.id,
        mapping.provider,
        mapping.externalId,
        mapping.checkoutMode,
        JSON.stringify(metadata)
      ]
    );
    directMappingsApplied += 1;
    if (mapping.active) mappingsPendingVerification += 1;
  }

  return { directMappingsApplied, skippedReferences, mappingsPendingVerification };
}

async function updatePlanPlacement({
  planId,
  strategy,
  poolMode,
  servers = [],
  actorUserId = null,
  auditMetadata = {}
}) {
  planContract.validateServerSelection({ poolMode, servers });
  return transaction(async client => {
    const updated = await client.query(
      'UPDATE plans SET placement_strategy=$2,updated_at=NOW() WHERE id=$1 RETURNING *',
      [planId, strategy]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [planId]);
    if (poolMode === 'selected') {
      for (const server of servers) {
        await client.query(
          'INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,$3)',
          [planId, server.id, server.weight]
        );
      }
    }

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.server_placement','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify(auditMetadata)]
    );
    return updated.rows[0];
  });
}

async function updatePlanInventory({
  planId,
  capacityLimit,
  actorUserId = null,
  auditMetadata = {}
}) {
  planContract.validateAvailability({ capacityLimit });
  return transaction(async client => {
    const updated = await client.query(
      `UPDATE plans
       SET capacity_limit=$2,updated_at=NOW()
       WHERE id=$1 AND archived_at IS NULL
       RETURNING code,name`,
      [planId, capacityLimit]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.inventory.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify(auditMetadata)]
    );
    return updated.rows[0];
  });
}

async function updatePlanOverview({
  planId,
  input,
  actorUserId = null,
  auditMetadata = {}
}) {
  return transaction(async client => {
    const before = await client.query(
      'SELECT server_class FROM plans WHERE id=$1 FOR UPDATE',
      [planId]
    );
    if (!before.rowCount) throw new Error('Plan not found.');
    const classChanged = before.rows[0].server_class !== input.serverClass;

    const updated = await client.query(
      `UPDATE plans SET
         name=$2,description=$3,audience=$4,billing_interval=$5,duration_days=$6,
         server_class=$7,visible=$8,active=$9,sort_order=$10,
         marketing_features=$11::text[],discord_role_id=$12,updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [
        planId, input.name, input.description, input.audience, input.billing,
        input.duration, input.serverClass, input.visible, input.active,
        input.sort, input.features, input.discordRoleId
      ]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    if (classChanged) {
      await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [planId]);
    }

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({ ...auditMetadata, classChanged })]
    );

    return { plan: updated.rows[0], classChanged };
  });
}

async function archivePlan({
  planId,
  actorUserId = null,
  auditMetadata = {}
}) {
  return transaction(async client => {
    const updated = await client.query(
      `UPDATE plans
       SET active=FALSE,visible=FALSE,archived_at=NOW(),archived_by=$2,updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [planId, actorUserId]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.archive','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify(auditMetadata)]
    );
    return updated.rows[0];
  });
}

async function unarchivePlan({ planId, actorUserId = null }) {
  return transaction(async client => {
    const updated = await client.query(
      `UPDATE plans
       SET archived_at=NULL,archived_by=NULL,active=TRUE,visible=FALSE,updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [planId]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.unarchive','plan',$2,'{}'::jsonb)`,
      [actorUserId, planId]
    );
    return updated.rows[0];
  });
}

async function updateDeliveryService({
  planId,
  nextType,
  actorUserId = null,
  validate = null
}) {
  return transaction(async client => {
    const found = await client.query('SELECT * FROM plans WHERE id=$1 FOR UPDATE', [planId]);
    if (!found.rowCount) throw new Error('Plan not found.');
    const plan = found.rows[0];

    const live = await client.query(
      `SELECT COUNT(DISTINCT customer_id)::int n
       FROM subscriptions
       WHERE plan_id=$1
         AND superseded_by IS NULL
         AND status IN ('active','trialing','past_due','paused')
         AND starts_at<=NOW()
         AND current_period_end>NOW()`,
      [planId]
    );
    const liveSubscriptions = Number(live.rows[0]?.n || 0);

    const validation = typeof validate === 'function'
      ? await validate({ plan, liveSubscriptions, client })
      : null;

    const updated = await client.query(
      'UPDATE plans SET service_type=$2,updated_at=NOW() WHERE id=$1 RETURNING *',
      [planId, nextType]
    );

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.delivery.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({
        from: validation?.from || plan.service_type,
        to: nextType,
        liveSubscriptions,
        snapshotsPreserved: true
      })]
    );

    return { plan: updated.rows[0], previousPlan: plan, liveSubscriptions };
  });
}

function legacyPlanCode(value){
  const code=String(value||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9-]{1,49}$/.test(code))throw new Error('Code must use lowercase letters, numbers and hyphens.');
  return code;
}

function legacyPlanName(value){
  const name=String(value||'').trim().slice(0,100);
  if(!name)throw new Error('Name is required.');
  return name;
}

function legacyEffectiveDate(value){
  if(!String(value||'').trim())return null;
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))throw new Error('Effective date is invalid.');
  return date;
}

function schemaIdentifier(name){
  if(!/^[a-z_][a-z0-9_]*$/.test(name))throw new Error('Unsafe schema identifier');
  return `"${name}"`;
}

async function createBasicPlan(plan,actorUserId=null){
  return transaction(async client=>{
    const created=await client.query(
      `INSERT INTO plans(code,name,description,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,is_addon,server_class,visible,active,sort_order,streams,allow_remuxing,allow_remote_access)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,FALSE,TRUE)
       RETURNING *`,
      [plan.code,plan.name,plan.description,plan.serviceType,plan.audience,plan.billing,plan.duration,plan.priceMinor,plan.currency,plan.capacityLimit,plan.isAddon,plan.serverClass,plan.visible,plan.active,plan.sortOrder,plan.streams]
    );
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.create','plan',$2,$3::jsonb)`,
      [actorUserId,created.rows[0].id,JSON.stringify({
        code:plan.code,name:plan.name,serviceType:plan.serviceType,audience:plan.audience,
        billingInterval:plan.billing,durationDays:plan.duration,priceMinor:plan.priceMinor,
        currency:plan.currency,capacityLimit:plan.capacityLimit,streams:plan.streams,isAddon:plan.isAddon
      })]
    );
    return created.rows[0];
  });
}

async function clonePlanVersion(sourceId,{code,name,effectiveFrom=null},actorUserId=null){
  code=legacyPlanCode(code);
  name=legacyPlanName(name);
  effectiveFrom=legacyEffectiveDate(effectiveFrom);
  return transaction(async client=>{
    const source=(await client.query('SELECT * FROM plans WHERE id=$1 FOR SHARE',[sourceId])).rows[0];
    if(!source)throw new Error('Plan not found.');
    const cols=(await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='plans'
         AND is_generated='NEVER' AND identity_generation IS NULL
       ORDER BY ordinal_position`
    )).rows.map(x=>x.column_name).filter(c=>!new Set([
      'id','code','name','active','visible','archived_at','archived_by','created_at','updated_at',
      'version_group_id','version_number','effective_from','effective_until'
    ]).has(c));
    const group=source.version_group_id||source.id;
    const version=Number((await client.query(
      `SELECT COALESCE(MAX(version_number),0)::int+1 n
       FROM plans WHERE COALESCE(version_group_id,id)=$1`,
      [group]
    )).rows[0].n||2);
    const values=cols.map(col=>source[col]);
    const params=values.map((_,i)=>`${i+6}`);
    const inserted=(await client.query(
      `INSERT INTO plans(code,name,active,visible,version_group_id,version_number,effective_from,${cols.map(schemaIdentifier).join(',')})
       VALUES($1,$2,FALSE,FALSE,$3,$4,$5,${params.join(',')})
       RETURNING *`,
      [code,name,group,version,effectiveFrom,...values]
    )).rows[0];
    await client.query(
      `INSERT INTO plan_server_eligibility(plan_id,server_id,weight)
       SELECT $1,server_id,weight FROM plan_server_eligibility WHERE plan_id=$2
       ON CONFLICT DO NOTHING`,
      [inserted.id,sourceId]
    );
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.clone','plan',$2,$3::jsonb)`,
      [actorUserId,inserted.id,JSON.stringify({sourceId,version,effectiveFrom,providerMappingsCopied:false})]
    );
    return inserted;
  });
}

async function switchCatalogueCurrency(client,currency){
  const plans=(await client.query(
    `SELECT id,price_minor,currency,is_free_tier FROM plans
     WHERE archived_at IS NULL ORDER BY id FOR UPDATE`
  )).rows;
  if(!plans.length)return{plans:0,invalidatedMappings:0};
  const ids=plans.map(row=>row.id);
  const existing=(await client.query(
    `SELECT id,plan_id,price_minor FROM plan_prices
     WHERE currency=$1 AND plan_id=ANY($2::uuid[])`,
    [currency,ids]
  )).rows;
  const priorByPlan=new Map(existing.map(row=>[String(row.plan_id),row]));
  await client.query(`
    UPDATE plan_prices pr
       SET active=CASE WHEN p.is_free_tier THEN TRUE ELSE FALSE END,
           is_default=FALSE,
           updated_at=NOW()
      FROM plans p
     WHERE pr.plan_id=p.id AND pr.plan_id=ANY($1::uuid[])
  `,[ids]);
  await client.query(
    `UPDATE plan_provider_prices pp
     SET active=FALSE,updated_at=NOW()
     FROM plan_prices pr
     WHERE pp.plan_price_id=pr.id AND pr.plan_id=ANY($1::uuid[]) AND pr.currency<>$2`,
    [ids,currency]
  );
  let invalidatedMappings=0;
  for(const plan of plans){
    const amount=plan.is_free_tier?0:Number(plan.price_minor||0);
    const prior=priorByPlan.get(String(plan.id));
    const target=await client.query(
      `INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default)
       VALUES($1,$2,$3,TRUE,TRUE)
       ON CONFLICT(plan_id,currency)
       DO UPDATE SET price_minor=EXCLUDED.price_minor,active=TRUE,is_default=TRUE,updated_at=NOW()
       RETURNING id`,
      [plan.id,currency,amount]
    );
    if(prior&&Number(prior.price_minor)!==amount){
      const changed=await client.query(
        `UPDATE plan_provider_prices
         SET active=FALSE,verification_status='unverified',
             verification_error='Portal currency switch changed the catalogue amount; re-verification required.',
             updated_at=NOW()
         WHERE plan_price_id=$1 AND active=TRUE`,
        [target.rows[0].id]
      );
      invalidatedMappings+=Number(changed.rowCount||0);
    }
  }
  await client.query(
    'UPDATE plans SET currency=$1,updated_at=NOW() WHERE id=ANY($2::uuid[])',
    [currency,ids]
  );
  return{plans:plans.length,invalidatedMappings};
}


async function updateStorefrontOrder({
  standardIds = [],
  stremioIds = [],
  freePlanId = null,
  actorUserId = null
}) {
  const submitted = { standard: standardIds.map(String), stremio: stremioIds.map(String) };
  return transaction(async client => {
    let order = 100;
    for (const id of submitted.standard) {
      const updated = await client.query(
        'UPDATE plans SET sort_order=$2,updated_at=NOW() WHERE id=$1 RETURNING id',
        [id, order]
      );
      if (!updated.rowCount) throw new Error('A paid plan changed while storefront order was being saved.');
      order += 100;
    }

    order = 100;
    for (const id of submitted.stremio) {
      const updated = await client.query(
        'UPDATE plans SET sort_order=$2,updated_at=NOW() WHERE id=$1 RETURNING id',
        [id, order]
      );
      if (!updated.rowCount) throw new Error('A Stremio plan changed while storefront order was being saved.');
      order += 100;
    }

    if (freePlanId) {
      const pinned = await client.query(
        'UPDATE plans SET sort_order=0,updated_at=NOW() WHERE id=$1 RETURNING id',
        [freePlanId]
      );
      if (!pinned.rowCount) throw new Error('The Free plan changed while storefront order was being saved.');
    }

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,metadata)
       VALUES($1,'admin.storefront.order.update','catalogue',$2::jsonb)`,
      [actorUserId, JSON.stringify(submitted)]
    );
    return submitted;
  });
}

async function updateRequestPolicy({
  planId,
  movieLimit,
  movieDays,
  tvLimit,
  tvDays,
  requestAccessEnabled,
  requestPermissions,
  watchlistSyncMovies,
  watchlistSyncTv,
  locale,
  discoverRegion,
  streamingRegion,
  originalLanguage,
  confirmDestructiveDisable = false,
  actorUserId = null
}) {
  return transaction(async client => {
    const current = await client.query(
      'SELECT id,name,service_type,COALESCE(request_access_enabled,TRUE) AS request_access_enabled FROM plans WHERE id=$1 FOR UPDATE',
      [planId]
    );
    if (!current.rowCount) throw new Error('Plan not found.');

    const disabling = current.rows[0].request_access_enabled === true && requestAccessEnabled === false;
    if (disabling && !confirmDestructiveDisable) {
      throw new Error('Confirm that disabling request access will delete managed Seerr accounts and their Seerr request history.');
    }

    const updated = await client.query(
      `UPDATE plans
       SET request_movie_quota_limit=$2,
           request_movie_quota_days=$3,
           request_tv_quota_limit=$4,
           request_tv_quota_days=$5,
           request_access_enabled=$6,
           request_permissions=$7,
           request_watchlist_sync_movies=$8,
           request_watchlist_sync_tv=$9,
           request_locale=$10,
           request_discover_region=$11,
           request_streaming_region=$12,
           request_original_language=$13,
           updated_at=NOW()
       WHERE id=$1
       RETURNING name,service_type`,
      [
        planId, movieLimit, movieDays, tvLimit, tvDays, requestAccessEnabled,
        requestPermissions, watchlistSyncMovies, watchlistSyncTv, locale,
        discoverRegion, streamingRegion, originalLanguage
      ]
    );

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'plan.request_policy.update','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({
        movieLimit,
        movieDays,
        tvLimit,
        tvDays,
        requestAccessEnabled,
        destructiveDisableConfirmed: disabling,
        permissionMode: requestPermissions == null ? 'preserve' : 'managed',
        requestPermissions,
        watchlistSyncMovies,
        watchlistSyncTv,
        locale,
        discoverRegion,
        streamingRegion,
        originalLanguage
      })]
    );

    return { plan: updated.rows[0], disabling };
  });
}



async function updateFourKTranscodePolicy({
  planId,
  enabled,
  previous = false,
  liveEntitlements = 0,
  actorUserId = null
}) {
  return transaction(async client => {
    const updated = await client.query(
      'UPDATE plans SET kick_4k_transcodes=$2,updated_at=NOW() WHERE id=$1 RETURNING *',
      [planId, Boolean(enabled)]
    );
    if (!updated.rowCount) throw new Error('Plan not found.');
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.4k_transcode_policy','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify({
        enabled: Boolean(enabled),
        previous: Boolean(previous),
        liveEntitlements: Number(liveEntitlements || 0)
      })]
    );
    return updated.rows[0];
  });
}

module.exports = {
  createBasicPlan,
  clonePlanVersion,
  switchCatalogueCurrency,
  createPlan,
  updateProduct,
  updateAvailability,
  updateDelivery,
  updateLibraries,
  updateCommerce,
  saveProviderOption,
  updatePaymentOptions,
  updatePortalCurrencyPrice,
  planSubscriberCount,
  clearPlanLeases,
  updateAccessPolicy,
  updateStremioCommerce,
  updateStremioStorefront,
  updateStremioTrackingSnapshots,
  updateStremioAccess,
  updateStremioAvailability,
  upsertEmbyPlan,
  saveImportedLegacyPlan,
  saveImportedV2Plan,
  applyImportedPlans,
  applyImportedProviderMappings,
  updatePlanPlacement,
  updatePlanInventory,
  updatePlanOverview,
  archivePlan,
  unarchivePlan,
  updateDeliveryService,
  updateStorefrontOrder,
  updateRequestPolicy,
  updateFourKTranscodePolicy
};
