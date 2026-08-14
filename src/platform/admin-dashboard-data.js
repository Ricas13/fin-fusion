'use strict';
const {query}=require('../db');
const {setupReadiness}=require('./setup-readiness');

function boundedInt(value,min,max,fallback){
  const n=parseInt(value,10);
  return Number.isFinite(n)&&n>=min&&n<=max?n:fallback;
}

async function dashboardOptions(){
  const result=await query("SELECT setting_value FROM platform_settings WHERE setting_key='admin_defaults'");
  const value=result.rows[0]?.setting_value||{};
  return{
    expiringWindowDays:boundedInt(value.expiringWindowDays,1,30,3),
    recentCustomerLimit:boundedInt(value.recentCustomerLimit,5,50,12)
  };
}

async function dashboardData(){
  const options=await dashboardOptions();
  const [customers,subscriptions,playback,servers,policyEvents,resellers,pending,expiring,recent,serverRows,paymentFailures,resellerRows,requestRows,expiringRows,setup]=await Promise.all([
    query('SELECT COUNT(*)::int AS count FROM customers'),
    query("SELECT COUNT(*)::int AS count FROM subscriptions WHERE status IN ('active','trialing') AND current_period_end > NOW()"),
    query("SELECT COUNT(*)::int AS streams,COUNT(*) FILTER(WHERE playback_method='transcode')::int AS transcodes FROM active_playback_sessions"),
    query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE health_status='healthy')::int AS healthy,COUNT(*) FILTER(WHERE health_status='offline')::int AS offline FROM jellyfin_servers WHERE enabled=TRUE"),
    query("SELECT decision,COUNT(*)::int AS count FROM stream_policy_events WHERE created_at > NOW()-INTERVAL '24 hours' GROUP BY decision"),
    query('SELECT COUNT(*)::int AS count,COALESCE(SUM(credits),0)::int AS credits,COALESCE(SUM(trial_credits),0)::int AS trial_credits FROM resellers'),
    query("SELECT COUNT(*)::int AS count FROM content_requests WHERE status='pending'"),
    query("SELECT COUNT(*)::int AS count FROM subscriptions WHERE status IN ('active','trialing') AND current_period_end>NOW() AND current_period_end<=NOW()+($1::int * INTERVAL '1 day')",[options.expiringWindowDays]),
    query(`SELECT c.id,COALESCE(c.display_name,au.username,c.email,'Customer') name,c.email,c.created_at,s.status,s.current_period_end,p.name plan_name,ja.jellyfin_username,js.name server_name FROM customers c LEFT JOIN app_users au ON au.id=c.user_id LEFT JOIN LATERAL(SELECT * FROM subscriptions x WHERE x.customer_id=c.id ORDER BY x.created_at DESC LIMIT 1)s ON TRUE LEFT JOIN plans p ON p.id=s.plan_id LEFT JOIN LATERAL(SELECT * FROM jellyfin_accounts x WHERE x.customer_id=c.id ORDER BY x.created_at ASC LIMIT 1)ja ON TRUE LEFT JOIN jellyfin_servers js ON js.id=ja.server_id ORDER BY c.created_at DESC LIMIT $1`,[options.recentCustomerLimit]),
    query(`SELECT js.id,js.name,js.server_class,js.health_status,js.last_health_check,js.max_users,(SELECT COUNT(*)::int FROM jellyfin_accounts ja WHERE ja.server_id=js.id) assigned_users,(SELECT COUNT(*)::int FROM active_playback_sessions aps WHERE aps.server_id=js.id) active_streams FROM jellyfin_servers js WHERE js.enabled=TRUE ORDER BY js.priority,js.name LIMIT 8`),
    query("SELECT COUNT(*)::int AS count FROM payment_events WHERE processing_error IS NOT NULL AND created_at>NOW()-INTERVAL '24 hours'"),
    query(`SELECT r.id,u.username,u.active,r.credits,r.trial_credits,COUNT(c.id)::int customers FROM resellers r JOIN app_users u ON u.id=r.user_id LEFT JOIN customers c ON c.reseller_id=r.id GROUP BY r.id,u.id ORDER BY u.last_login_at DESC NULLS LAST,r.created_at DESC LIMIT 8`),
    query(`SELECT cr.id,COALESCE(cr.title,cr.request_text,'Request') title,cr.media_type,cr.created_at,COALESCE(c.display_name,u.username,'Unknown') requester FROM content_requests cr LEFT JOIN customers c ON c.id=cr.customer_id LEFT JOIN resellers rr ON rr.id=cr.reseller_id LEFT JOIN app_users u ON u.id=rr.user_id WHERE cr.status='pending' ORDER BY cr.created_at DESC LIMIT 6`),
    query(`SELECT c.id,COALESCE(c.display_name,au.username,c.email,'Customer') name,s.current_period_end,p.name plan_name FROM subscriptions s JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users au ON au.id=c.user_id JOIN plans p ON p.id=s.plan_id WHERE s.status IN ('active','trialing') AND s.current_period_end>NOW() AND s.current_period_end<=NOW()+($1::int * INTERVAL '1 day') ORDER BY s.current_period_end ASC LIMIT 8`,[options.expiringWindowDays]),
    setupReadiness()
  ]);
  const policy=Object.fromEntries(policyEvents.rows.map(r=>[r.decision,Number(r.count)]));
  return{
    customers:+customers.rows[0].count||0,
    activeSubscriptions:+subscriptions.rows[0].count||0,
    activeStreams:+playback.rows[0].streams||0,
    transcodes:+playback.rows[0].transcodes||0,
    servers:+servers.rows[0].total||0,
    healthyServers:+servers.rows[0].healthy||0,
    offlineServers:+servers.rows[0].offline||0,
    wouldStop24h:+policy.would_stop||0,
    safetySkips24h:+policy.skipped_safety||0,
    resellers:+resellers.rows[0].count||0,
    credits:+resellers.rows[0].credits||0,
    trialCredits:+resellers.rows[0].trial_credits||0,
    pendingRequests:+pending.rows[0].count||0,
    expiringSoon:+expiring.rows[0].count||0,
    paymentFailures24h:+paymentFailures.rows[0].count||0,
    recentCustomers:recent.rows,
    serverRows:serverRows.rows,
    resellerRows:resellerRows.rows,
    requestRows:requestRows.rows,
    expiringRows:expiringRows.rows,
    setup,
    options
  };
}
module.exports={dashboardData};
