'use strict';

const {query}=require('../db');
const accessHolds=require('../entitlements/access-holds');
const planPolicy=require('../entitlements/plan-lifecycle-policy');
const lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy');
const provisioning=require('../jellyfin/resilient-provisioning');

const HOLD_TYPE='inactivity_policy';
const FREE_POLICY_DEFAULTS=Object.freeze({firstPlaybackGraceDays:3,playbackWindowDays:7,minimumPlaybackMinutes:30});

function asDate(value){if(!value)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date:null;}
function boundedInt(value,min,max,fallback){const n=Number.parseInt(value,10);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function serverPolicy(row={},globalCfg={}){
  const legacy=planPolicy.effectiveForFreePlan({},globalCfg);
  const playbackWindowDays=boundedInt(row.free_playback_window_days,1,365,FREE_POLICY_DEFAULTS.playbackWindowDays);
  return{
    ...legacy,
    enabled:Boolean(globalCfg.enabled),
    dryRun:Boolean(globalCfg.dryRun),
    firstPlaybackGraceDays:boundedInt(row.free_first_playback_grace_days,1,3650,FREE_POLICY_DEFAULTS.firstPlaybackGraceDays),
    // The Free Server policy has one post-activation requirement: meet the
    // minimum watch time inside the rolling playback window. Jellyfin login/
    // LastActivityDate is observational only and never keeps access alive.
    noPlaybackDays:null,
    minimumPlaybackMinutes:boundedInt(row.free_minimum_playback_minutes,1,1000000,FREE_POLICY_DEFAULTS.minimumPlaybackMinutes),
    playbackWindowDays,
    inherited:{...legacy.inherited,firstPlaybackGraceDays:false,noPlaybackDays:false,minimumPlaybackMinutes:false,playbackWindowDays:false},
    thresholdOwner:'free_server'
  };
}
function assessUsage(row,policy,now=Date.now()){
  const startsAt=asDate(row.starts_at),accountCreatedAt=asDate(row.account_created_at),allocationStartAt=asDate(row.allocation_start_at)||accountCreatedAt||startsAt;
  const rawFirstPlaybackAt=asDate(row.first_playback_at),rawLastPlaybackAt=asDate(row.last_playback_at),rawLastActivityAt=asDate(row.last_activity_at);
  let firstPlaybackAt=rawFirstPlaybackAt&&(!allocationStartAt||rawFirstPlaybackAt.getTime()>=allocationStartAt.getTime())?rawFirstPlaybackAt:null;
  const lastPlaybackAt=rawLastPlaybackAt&&(!allocationStartAt||rawLastPlaybackAt.getTime()>=allocationStartAt.getTime())?rawLastPlaybackAt:null;
  const lastActivityAt=rawLastActivityAt&&(!allocationStartAt||rawLastActivityAt.getTime()>=allocationStartAt.getTime())?rawLastActivityAt:null;
  if(!firstPlaybackAt&&lastPlaybackAt)firstPlaybackAt=lastPlaybackAt;
  const hasPlayback=Boolean(firstPlaybackAt||lastPlaybackAt);
  const phasedActivation=policy.firstPlaybackGraceDays!=null;
  // Playback is the only activity signal that affects eligibility. Login,
  // browsing and Jellyfin LastActivityDate must never satisfy either the first
  // playback rule or the rolling playback requirement.
  const referenceAt=lastPlaybackAt||allocationStartAt;
  const observationStartedAt=hasPlayback?(firstPlaybackAt||lastPlaybackAt):allocationStartAt;
  const activationAgeHours=allocationStartAt?Math.max(0,(now-allocationStartAt.getTime())/3600000):0;
  const ageHours=observationStartedAt?Math.max(0,(now-observationStartedAt.getTime())/3600000):0;
  const seconds=Number(row.playback_seconds||0);
  const retentionReady=hasPlayback||!phasedActivation;
  const firstPlaybackEligible=!hasPlayback&&phasedActivation&&activationAgeHours>=Math.max(policy.minimumObservationHours,policy.firstPlaybackGraceDays*24);
  const noPlaybackEligible=retentionReady&&policy.noPlaybackDays!=null&&ageHours>=Math.max(policy.minimumObservationHours,policy.noPlaybackDays*24)&&referenceAt&&referenceAt.getTime()<=now-policy.noPlaybackDays*86400000;
  const usageEligible=retentionReady&&policy.minimumPlaybackMinutes!=null&&ageHours>=Math.max(policy.minimumObservationHours,policy.playbackWindowDays*24)&&seconds<policy.minimumPlaybackMinutes*60;
  return{allocationStartAt,firstPlaybackAt,lastPlaybackAt,lastActivityAt,hasPlayback,referenceAt,observationStartedAt,activationAgeHours,ageHours,seconds,firstPlaybackEligible,noPlaybackEligible,usageEligible};
}

async function candidates(globalCfg=null,{customerId=null}={}){
  globalCfg=globalCfg||await lifecyclePolicy.get();
  if(!globalCfg.enabled)return[];
  const result=await query(`
    WITH free_access AS (
      SELECT DISTINCT ON (s.customer_id)
        s.customer_id,s.id subscription_id,s.plan_id,s.starts_at,s.current_period_end,s.source subscription_source,
        p.code plan_code,p.name plan_name,p.inactivity_policy
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused')
        AND s.starts_at<=NOW() AND s.current_period_end>NOW()
        AND p.is_free_tier=TRUE AND p.price_minor=0
        AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
        AND ($2::uuid IS NULL OR s.customer_id=$2::uuid)
      ORDER BY s.customer_id,s.current_period_end DESC,s.created_at DESC
    )
    SELECT fa.*,ja.id account_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,ja.created_at account_created_at,
      allocation.allocation_start_at,ja.last_activity_at,js.name server_name,
      js.free_first_playback_grace_days,js.free_playback_window_days,js.free_minimum_playback_minutes,
      COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,COALESCE(c.email,u.email) email,c.automation_protected,
      us.first_playback_at,us.last_playback_at,COALESCE(us.playback_seconds,0)::bigint playback_seconds,
      COALESCE(historical.any_playback_history,FALSE) any_playback_history,
      EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.jellyfin_account_id=ja.id) currently_playing,
      EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=fa.customer_id AND h.hold_type=$1 AND h.source_key=('plan:'||fa.plan_id::text) AND h.released_at IS NULL) already_held
    FROM free_access fa
    JOIN customers c ON c.id=fa.customer_id LEFT JOIN app_users u ON u.id=c.user_id
    JOIN jellyfin_accounts ja ON ja.customer_id=fa.customer_id AND ja.account_purpose='jellyfin' AND ja.access_lane='free' AND ja.disabled=FALSE
    JOIN jellyfin_servers js ON js.id=ja.server_id
    LEFT JOIN LATERAL (
      SELECT MAX(jal.restored_at) FILTER(WHERE jal.restored_at<=NOW()) restored_at
      FROM jellyfin_account_lifecycle jal
      WHERE jal.customer_id=fa.customer_id AND jal.category='free' AND jal.restored_at IS NOT NULL
        AND jal.metadata->>'restoredReason'='admin_reenable'
        AND jal.metadata->>'explicitRestore'='true'
    ) lifecycle ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        MIN(ph.started_at) FILTER(WHERE ph.started_at>=ja.access_lane_changed_at) historical_first_playback_at,
        COUNT(*)>0 any_playback_history
      FROM playback_history ph
      WHERE ph.customer_id=fa.customer_id AND ph.server_id=ja.server_id
        AND (ph.jellyfin_account_id=ja.id OR ph.jellyfin_account_id IS NULL)
    ) historical ON TRUE
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN lifecycle.restored_at IS NOT NULL THEN GREATEST(fa.starts_at,ja.access_lane_changed_at,lifecycle.restored_at)
        WHEN historical.historical_first_playback_at IS NOT NULL
          THEN LEAST(fa.starts_at,ja.access_lane_changed_at,historical.historical_first_playback_at)
        ELSE GREATEST(fa.starts_at,ja.access_lane_changed_at)
      END allocation_start_at
    ) allocation ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(ph.started_at) FILTER(WHERE ph.started_at>=allocation.allocation_start_at) first_playback_at,
             MAX(COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at)) FILTER(WHERE ph.started_at>=allocation.allocation_start_at) last_playback_at,
             COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at))))
               FILTER(WHERE ph.started_at>=GREATEST(allocation.allocation_start_at,NOW()-(COALESCE(js.free_playback_window_days,7)||' days')::interval)),0)::bigint playback_seconds
      FROM playback_history ph
      WHERE ph.customer_id=fa.customer_id AND ph.server_id=ja.server_id
        AND (ph.jellyfin_account_id=ja.id OR ph.jellyfin_account_id IS NULL)
    ) us ON TRUE
    WHERE NOT EXISTS(SELECT 1 FROM customer_bans b WHERE b.customer_id=fa.customer_id AND b.revoked_at IS NULL AND b.blocks_service_access=TRUE)
    ORDER BY COALESCE(us.last_playback_at,allocation.allocation_start_at),customer_name
  `,[HOLD_TYPE,customerId||null]);
  return result.rows.map(row=>{
    const policy=serverPolicy(row,globalCfg),assessment=assessUsage(row,policy),usageTriggered=planPolicy.usageTriggered(assessment,policy),eligible=policy.enabled&&!row.automation_protected&&!row.currently_playing&&usageTriggered,triggers=[];
    if(assessment.firstPlaybackEligible)triggers.push(`no first Free Server playback within ${policy.firstPlaybackGraceDays} day(s) of this allocation`);
    if(assessment.noPlaybackEligible)triggers.push(`no Free Server activity for ${policy.noPlaybackDays} day(s)`);
    if(assessment.usageEligible)triggers.push(`${Math.round(assessment.seconds/60)} min played on Free Server in ${policy.playbackWindowDays} day(s), below ${policy.minimumPlaybackMinutes} min`);
    return{...row,policy,first_playback_at:assessment.firstPlaybackAt,last_playback_at:assessment.lastPlaybackAt,last_activity_at:assessment.lastActivityAt,allocation_start_at:assessment.allocationStartAt,playback_seconds:assessment.seconds,inactive_reference_at:assessment.referenceAt,observation_started_at:assessment.observationStartedAt,has_playback:assessment.hasPlayback,eligible,repairExistingHold:Boolean(row.already_held&&eligible),triggers,reasons:eligible?triggers:[!policy.enabled?'Free Server usage rules disabled globally':null,row.automation_protected?'admin protected':null,row.currently_playing?'currently playing on Free Server':null,row.already_held?'already held':null,policy.enabled&&!usageTriggered?(assessment.hasPlayback?'rolling Free Server playback requirement is currently satisfied or still inside its observation window':'first-play grace period has not expired'):null].filter(Boolean)};
  }).filter(row=>planPolicy.hasUsageTrigger(row.policy));
}

async function releaseObsoletePlanHolds(actorUserId=null,globalCfg=null){globalCfg=globalCfg||await lifecyclePolicy.get();const rows=await query(`SELECT h.customer_id,h.source_key,p.is_free_tier,p.price_minor,p.service_type,EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=h.customer_id AND s.plan_id=p.id AND s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused') AND s.starts_at<=NOW() AND s.current_period_end>NOW()) active_subscription FROM customer_access_holds h LEFT JOIN plans p ON h.source_key=('plan:'||p.id::text) WHERE h.hold_type=$1 AND h.released_at IS NULL`,[HOLD_TYPE]);let released=0;for(const row of rows.rows){const keep=Boolean(row.active_subscription&&row.is_free_tier&&Number(row.price_minor||0)===0&&['jellyfin','bundle'].includes(String(row.service_type||'jellyfin')));if(keep)continue;await accessHolds.releaseHold({customerId:row.customer_id,type:HOLD_TYPE,sourceKey:row.source_key,actorUserId});await provisioning.reconcileCustomer(row.customer_id).catch(()=>{});released++;}return released;}

module.exports={HOLD_TYPE,FREE_POLICY_DEFAULTS,serverPolicy,assessUsage,candidates,releaseObsoletePlanHolds};
