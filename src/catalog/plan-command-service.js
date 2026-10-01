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

module.exports = { createPlan };
