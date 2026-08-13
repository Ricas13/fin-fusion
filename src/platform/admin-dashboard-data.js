'use strict';
const {query}=require('../db');
async function dashboardData(){
  const [customers,subscriptions,playback,servers,policyEvents,resellers,pending,expiring,recent,serverRows,paymentFailures]=await Promise.all([
    query('SELECT COUNT(*)::int AS count FROM customers'),
    query("SELECT COUNT(*)::int AS count FROM subscriptions WHERE status IN ('active','trialing') AND current_period_end > NOW()"),
    query("SELECT COUNT(*)::int AS streams,COUNT(*) FILTER(WHERE playback_method='transcode')::int AS transcodes FROM active_playback_sessions"),
    query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE health_status='healthy')::int AS healthy,COUNT(*) FILTER(WHERE health_status='offline')::int AS offline FROM jellyfin_servers WHERE enabled=TRUE"),
    query("SELECT decision,COUNT(*)::int AS count FROM stream_policy_events WHERE created_at > NOW()-INTERVAL '24 hours' GROUP BY decision"),
    query('SELECT COUNT(*)::int AS count,COALESCE(SUM(credits),0)::int AS credits,COALESCE(SUM(trial_credits),0)::int AS trial_credits FROM resellers'),
    query("SELECT COUNT(*)::int AS count FROM content_requests WHERE status='pending'"),
    query("SELECT COUNT(*)::int AS count FROM subscriptions WHERE status IN ('active','trialing') AND current_period_end>NOW() AND current_period_end<=NOW()+INTERVAL '3 days'"),
    query(`SELECT c.id,COALESCE(c.display_name,au.username,c.email,'Customer') name,c.email,c.created_at,s.status,s.current_period_end,p.name plan_name,ja.jellyfin_username,js.name server_name FROM customers c LEFT JOIN app_users au ON au.id=c.user_id LEFT JOIN LATERAL(SELECT * FROM subscriptions x WHERE x.customer_id=c.id ORDER BY x.created_at DESC LIMIT 1)s ON TRUE LEFT JOIN plans p ON p.id=s.plan_id LEFT JOIN LATERAL(SELECT * FROM jellyfin_accounts x WHERE x.customer_id=c.id ORDER BY x.created_at ASC LIMIT 1)ja ON TRUE LEFT JOIN jellyfin_servers js ON js.id=ja.server_id ORDER BY c.created_at DESC LIMIT 12`),
    query(`SELECT js.id,js.name,js.server_class,js.health_status,js.last_health_check,js.max_users,(SELECT COUNT(*)::int FROM jellyfin_accounts ja WHERE ja.server_id=js.id) assigned_users,(SELECT COUNT(*)::int FROM active_playback_sessions aps WHERE aps.server_id=js.id) active_streams FROM jellyfin_servers js WHERE js.enabled=TRUE ORDER BY js.priority,js.name LIMIT 8`),
    query("SELECT COUNT(*)::int AS count FROM payment_events WHERE processing_error IS NOT NULL AND created_at>NOW()-INTERVAL '24 hours'")
  ]);
  const policy=Object.fromEntries(policyEvents.rows.map(r=>[r.decision,Number(r.count)]));
  return{customers:+customers.rows[0].count||0,activeSubscriptions:+subscriptions.rows[0].count||0,activeStreams:+playback.rows[0].streams||0,transcodes:+playback.rows[0].transcodes||0,servers:+servers.rows[0].total||0,healthyServers:+servers.rows[0].healthy||0,offlineServers:+servers.rows[0].offline||0,wouldStop24h:+policy.would_stop||0,safetySkips24h:+policy.skipped_safety||0,resellers:+resellers.rows[0].count||0,credits:+resellers.rows[0].credits||0,trialCredits:+resellers.rows[0].trial_credits||0,pendingRequests:+pending.rows[0].count||0,expiringSoon:+expiring.rows[0].count||0,paymentFailures24h:+paymentFailures.rows[0].count||0,recentCustomers:recent.rows,serverRows:serverRows.rows};
}
module.exports={dashboardData};