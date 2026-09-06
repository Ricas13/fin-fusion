'use strict';

const {query}=require('../db');
const accessHolds=require('../entitlements/access-holds');
const planPolicy=require('../entitlements/plan-lifecycle-policy');
const lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy');
const provisioning=require('../jellyfin/resilient-provisioning');

const HOLD_TYPE='inactivity_policy';

function asDate(value){if(!value)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date:null;}
function earliestDate(values){const dates=values.map(asDate).filter(Boolean);if(!dates.length)return null;return new Date(Math.min(...dates.map(date=>date.getTime())));}
function assessUsage(row,policy,now=Date.now()){
  const lastPlaybackAt=asDate(row.last_playback_at),lastActivityAt=asDate(row.last_activity_at),accountCreatedAt=asDate(row.account_created_at),startsAt=asDate(row.starts_at);
  const referenceAt=lastPlaybackAt||lastActivityAt||accountCreatedAt||startsAt;
  const mappedAt=accountCreatedAt||startsAt;
  const historicalEvidenceAt=earliestDate([lastPlaybackAt,lastActivityAt]);
  const observationStartedAt=earliestDate([mappedAt,historicalEvidenceAt])||referenceAt;
  const ageHours=observationStartedAt?Math.max(0,(now-observationStartedAt.getTime())/3600000):0;
  const seconds=Number(row.playback_seconds||0);
  const noPlaybackEligible=policy.noPlaybackDays!=null&&ageHours>=Math.max(policy.minimumObservationHours,policy.noPlaybackDays*24)&&referenceAt&&referenceAt.getTime()<=now-policy.noPlaybackDays*86400000;
  const usageEligible=policy.minimumPlaybackMinutes!=null&&ageHours>=Math.max(policy.minimumObservationHours,policy.playbackWindowDays*24)&&seconds<policy.minimumPlaybackMinutes*60;
  return{referenceAt,observationStartedAt,ageHours,seconds,noPlaybackEligible,usageEligible};
}

async function candidates(globalCfg=null,{customerId=null}={}){
  globalCfg=globalCfg||await lifecyclePolicy.get();
  if(!globalCfg.enabled)return[];
  const result=await query(`
    WITH free_access AS (
      SELECT DISTINCT ON (s.customer_id)
        s.customer_id,s.id subscription_id,s.plan_id,s.starts_at,s.current_period_end,p.code plan_code,p.name plan_name,p.inactivity_policy
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused')
        AND s.starts_at<=NOW() AND s.current_period_end>NOW()
        AND p.is_free_tier=TRUE AND p.price_minor=0
        AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
        AND ($2::uuid IS NULL OR s.customer_id=$2::uuid)
      ORDER BY s.customer_id,s.current_period_end DESC,s.created_at DESC
    )
    SELECT fa.*,ja.id account_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,ja.created_at account_created_at,ja.last_activity_at,js.name server_name,
      COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,COALESCE(c.email,u.email) email,c.automation_protected,
      us.last_playback_at,COALESCE(us.playback_seconds,0)::bigint playback_seconds,
      EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=fa.customer_id AND aps.server_id=ja.server_id) currently_playing,
      EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=fa.customer_id AND h.hold_type=$1 AND h.source_key=('plan:'||fa.plan_id::text) AND h.released_at IS NULL) already_held
    FROM free_access fa
    JOIN customers c ON c.id=fa.customer_id LEFT JOIN app_users u ON u.id=c.user_id
    JOIN jellyfin_accounts ja ON ja.customer_id=fa.customer_id AND ja.account_purpose='jellyfin' AND ja.access_lane='free' AND ja.disabled=FALSE
    JOIN jellyfin_servers js ON js.id=ja.server_id
    LEFT JOIN LATERAL (
      SELECT MAX(COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at)) last_playback_at,
             COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at))))
               FILTER(WHERE ph.started_at>=NOW()-(COALESCE(NULLIF(fa.inactivity_policy->>'playbackWindowDays','')::int,7)||' days')::interval),0)::bigint playback_seconds
      FROM playback_history ph
      WHERE ph.customer_id=fa.customer_id AND ph.server_id=ja.server_id
    ) us ON TRUE
    WHERE NOT EXISTS(SELECT 1 FROM customer_bans b WHERE b.customer_id=fa.customer_id AND b.revoked_at IS NULL AND b.blocks_service_access=TRUE)
    ORDER BY COALESCE(us.last_playback_at,ja.last_activity_at,ja.created_at),customer_name
  `,[HOLD_TYPE,customerId||null]);
  return result.rows.map(row=>{
    const policy=planPolicy.effectiveForFreePlan(row.inactivity_policy||{},globalCfg),assessment=assessUsage(row,policy),usageTriggered=planPolicy.usageTriggered(assessment,policy),eligible=policy.enabled&&!row.automation_protected&&!row.currently_playing&&usageTriggered,triggers=[];
    if(assessment.noPlaybackEligible)triggers.push(`no Free Server playback for ${policy.noPlaybackDays} day(s)`);
    if(assessment.usageEligible)triggers.push(`${Math.round(assessment.seconds/60)} min played on Free Server in ${policy.playbackWindowDays} day(s), below ${policy.minimumPlaybackMinutes} min`);
    return{...row,policy,playback_seconds:assessment.seconds,inactive_reference_at:assessment.referenceAt,observation_started_at:assessment.observationStartedAt,eligible,repairExistingHold:Boolean(row.already_held&&eligible),triggers,reasons:eligible?triggers:[!policy.enabled?'Free Server usage rules disabled for this plan':null,row.automation_protected?'admin protected':null,row.currently_playing?'currently playing on Free Server':null,row.already_held?'already held':null,policy.enabled&&!usageTriggered?'Free Server removal requires all configured usage rules to be met':null].filter(Boolean)};
  }).filter(row=>planPolicy.hasUsageTrigger(row.policy));
}

async function releaseObsoletePlanHolds(actorUserId=null,globalCfg=null){globalCfg=globalCfg||await lifecyclePolicy.get();const rows=await query(`SELECT h.customer_id,h.source_key,p.inactivity_policy,p.is_free_tier,p.price_minor,p.service_type,EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=h.customer_id AND s.plan_id=p.id AND s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused') AND s.starts_at<=NOW() AND s.current_period_end>NOW()) active_subscription FROM customer_access_holds h LEFT JOIN plans p ON h.source_key=('plan:'||p.id::text) WHERE h.hold_type=$1 AND h.released_at IS NULL`,[HOLD_TYPE]);let released=0;for(const row of rows.rows){const policy=planPolicy.effectiveForFreePlan(row.inactivity_policy||{},globalCfg),keep=Boolean(row.active_subscription&&row.is_free_tier&&Number(row.price_minor||0)===0&&['jellyfin','bundle'].includes(String(row.service_type||'jellyfin'))&&planPolicy.hasUsageTrigger(policy));if(keep)continue;await accessHolds.releaseHold({customerId:row.customer_id,type:HOLD_TYPE,sourceKey:row.source_key,actorUserId});await provisioning.reconcileCustomer(row.customer_id).catch(()=>{});released++;}return released;}

module.exports={HOLD_TYPE,assessUsage,candidates,releaseObsoletePlanHolds};
