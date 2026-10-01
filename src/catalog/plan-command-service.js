'use strict';

const { transaction } = require('../db');
const planPricing = require('../payments/plan-pricing');

async function createPlan(plan, actorUserId = null) {
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
       VALUES($1,'admin.plan.payment_options','plan',$2,$3::jsonb)`,
      [actorUserId, planId, JSON.stringify(auditMetadata)]
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

module.exports = {
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
  updateAccessPolicy
};
