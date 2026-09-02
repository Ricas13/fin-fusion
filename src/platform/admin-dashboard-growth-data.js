'use strict';

const { query } = require('../db');
const reportingCurrency = require('./reporting-currency');
const { fillSeries } = require('./admin-dashboard-analytics');

const PRIMARY_PAID = `COALESCE(p.is_addon,FALSE)=FALSE
  AND COALESCE(p.is_free_tier,FALSE)=FALSE
  AND COALESCE(s.price_minor_snapshot,p.price_minor,0)>0`;
const ACCESS_END = `(s.current_period_end + (COALESCE(s.service_extension_days,0)||' days')::interval)`;
const MONTHLY_EQUIVALENT = `ROUND(COALESCE(s.price_minor_snapshot,p.price_minor)::numeric * CASE COALESCE(s.billing_interval_snapshot,p.billing_interval)
  WHEN 'month' THEN 1
  WHEN '6_months' THEN 1.0/6
  WHEN 'year' THEN 1.0/12
  ELSE 30.4375/GREATEST(COALESCE(s.duration_days_snapshot,p.duration_days,30),1)
END)`;

function safeGrowthGrain(range) {
  return ['day','week','month'].includes(range?.bucket) ? range.bucket : 'day';
}
function playbackGrain(range) {
  if (range?.key === 'today' || Number(range?.days || 0) <= 2) return 'hour';
  if (Number(range?.days || 0) <= 45) return 'day';
  if (Number(range?.days || 0) <= 210) return 'week';
  return 'month';
}
function grainInterval(grain) {
  return { hour:'1 hour', day:'1 day', week:'1 week', month:'1 month' }[grain] || '1 day';
}
function labelFor(value, grain) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  if (grain === 'hour') return date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'});
  if (grain === 'month') return date.toLocaleDateString('en-GB',{month:'short',year:'2-digit',timeZone:'UTC'});
  if (grain === 'week') return date.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});
  return date.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});
}
function keyFor(value, grain) {
  const date = new Date(value);
  if (grain === 'hour') return date.toISOString().slice(0,13);
  if (grain === 'month') return date.toISOString().slice(0,7);
  return date.toISOString().slice(0,10);
}
function intervalMs(grain) {
  return { hour:3600000, day:86400000, week:604800000 }[grain] || null;
}
function startOfBucket(value, grain) {
  const d = new Date(value);
  if (grain === 'month') return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));
  if (grain === 'week') {
    const day = d.getUTCDay() || 7;
    return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-day+1));
  }
  if (grain === 'hour') return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),d.getUTCHours()));
  return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));
}
function nextBucket(value, grain) {
  const d = new Date(value);
  if (grain === 'month') return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));
  return new Date(d.getTime() + intervalMs(grain));
}
function emptySeries(range, grain) {
  const rows=[];
  let cursor=startOfBucket(range.start,grain),guard=0;
  while(cursor<range.end && guard++<1000){
    rows.push({key:keyFor(cursor,grain),label:labelFor(cursor,grain),bucket:new Date(cursor)});
    cursor=nextBucket(cursor,grain);
  }
  return rows;
}
function fillPlaybackSeries(range, grain, rows, fields) {
  const map=new Map((rows||[]).map(row=>[keyFor(row.bucket,grain),row]));
  return emptySeries(range,grain).map(point=>{
    const source=map.get(point.key)||{};
    const out={...point};
    for(const field of fields)out[field]=Number(source[field]||0);
    return out;
  });
}

async function growthMovement(range) {
  const grain=safeGrowthGrain(range);
  const [baselineResult,movementResult]=await Promise.all([
    query(`SELECT COUNT(DISTINCT s.customer_id)::int active
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE ${PRIMARY_PAID}
        AND s.starts_at<$1 AND ${ACCESS_END}>$1`,[range.start]),
    query(`WITH paid_intervals AS (
        SELECT s.customer_id,s.starts_at,${ACCESS_END} AS access_end
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE ${PRIMARY_PAID}
          AND s.starts_at<$2 AND ${ACCESS_END}>s.starts_at
      ), event_points AS (
        SELECT customer_id,occurred_at,SUM(delta)::int delta
        FROM (
          SELECT customer_id,starts_at occurred_at,1 delta FROM paid_intervals
          UNION ALL
          SELECT customer_id,access_end occurred_at,-1 delta FROM paid_intervals
        ) e GROUP BY customer_id,occurred_at
      ), states AS (
        SELECT customer_id,occurred_at,delta,
          COALESCE(SUM(delta) OVER(PARTITION BY customer_id ORDER BY occurred_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) before_count,
          SUM(delta) OVER(PARTITION BY customer_id ORDER BY occurred_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) after_count
        FROM event_points
      ), transitions AS (
        SELECT customer_id,occurred_at,
          CASE WHEN before_count=0 AND after_count>0 THEN 'activation'
               WHEN before_count>0 AND after_count=0 THEN 'churn' END transition
        FROM states
        WHERE (before_count=0 AND after_count>0) OR (before_count>0 AND after_count=0)
      ), first_activation AS (
        SELECT customer_id,MIN(occurred_at) first_at FROM transitions WHERE transition='activation' GROUP BY customer_id
      )
      SELECT date_trunc('${grain}',t.occurred_at) bucket,
        COUNT(*) FILTER(WHERE t.transition='activation' AND t.occurred_at=f.first_at)::int new_customers,
        COUNT(*) FILTER(WHERE t.transition='activation' AND t.occurred_at<>f.first_at)::int reactivations,
        COUNT(*) FILTER(WHERE t.transition='churn')::int churned
      FROM transitions t JOIN first_activation f USING(customer_id)
      WHERE t.occurred_at>=$1 AND t.occurred_at<$2
      GROUP BY 1 ORDER BY 1`,[range.start,range.end])
  ]);
  let active=Number(baselineResult.rows[0]?.active||0);
  const rows=fillSeries(range,movementResult.rows,['new_customers','reactivations','churned']).map(row=>{
    const opening=active,net=Number(row.new_customers)+Number(row.reactivations)-Number(row.churned);
    active=Math.max(0,active+net);
    return{...row,opening_active:opening,net_growth:net,active_subscribers:active,churn_rate:opening?Number(row.churned)/opening*100:null};
  });
  return{grain,baseline:Number(baselineResult.rows[0]?.active||0),rows,current:rows.at(-1)?.active_subscribers??active};
}

async function planTrend(range) {
  const grain=safeGrowthGrain(range),step=grainInterval(grain);
  const result=await query(`WITH buckets AS (
      SELECT gs AS bucket,LEAST(gs+INTERVAL '${step}',$2)-INTERVAL '1 microsecond' sample_at
      FROM generate_series(date_trunc('${grain}',$1::timestamptz),date_trunc('${grain}',($2::timestamptz-INTERVAL '1 microsecond')),INTERVAL '${step}') gs
    )
    SELECT b.bucket,COALESCE(NULLIF(s.plan_name_snapshot,''),p.name) plan_name,COUNT(*)::int subscriptions
    FROM buckets b
    JOIN subscriptions s ON s.starts_at<=b.sample_at AND ${ACCESS_END.replaceAll('s.','s.')}>b.sample_at
    JOIN plans p ON p.id=s.plan_id
    WHERE ${PRIMARY_PAID}
    GROUP BY b.bucket,COALESCE(NULLIF(s.plan_name_snapshot,''),p.name)
    ORDER BY b.bucket,subscriptions DESC`,[range.start,range.end]);
  const totals=new Map();
  for(const row of result.rows)totals.set(row.plan_name,(totals.get(row.plan_name)||0)+Number(row.subscriptions||0));
  const top=[...totals.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name])=>name);
  const series=top.map((label,index)=>({key:`plan_${index}`,label}));
  if([...totals.keys()].some(name=>!top.includes(name)))series.push({key:'plan_other',label:'Other'});
  const buckets=emptySeries(range,grain).map(point=>({...point}));
  const byKey=new Map(buckets.map(row=>[row.key,row]));
  for(const row of result.rows){
    const point=byKey.get(keyFor(row.bucket,grain));if(!point)continue;
    const index=top.indexOf(row.plan_name),key=index>=0?`plan_${index}`:'plan_other';
    point[key]=Number(point[key]||0)+Number(row.subscriptions||0);
  }
  for(const point of buckets)for(const item of series)point[item.key]=Number(point[item.key]||0);
  return{grain,rows:buckets,series};
}

async function mrrTrend(range,reporting) {
  const grain=safeGrowthGrain(range),step=grainInterval(grain);
  const result=await query(`WITH buckets AS (
      SELECT gs AS bucket,LEAST(gs+INTERVAL '${step}',$2)-INTERVAL '1 microsecond' sample_at
      FROM generate_series(date_trunc('${grain}',$1::timestamptz),date_trunc('${grain}',($2::timestamptz-INTERVAL '1 microsecond')),INTERVAL '${step}') gs
    )
    SELECT b.bucket,COALESCE(s.currency_snapshot,p.currency,'GBP') currency,SUM(${MONTHLY_EQUIVALENT})::bigint mrr_minor
    FROM buckets b
    JOIN subscriptions s ON s.starts_at<=b.sample_at AND ${ACCESS_END}>b.sample_at
    JOIN plans p ON p.id=s.plan_id
    WHERE COALESCE(s.price_minor_snapshot,p.price_minor,0)>0
      AND ((s.source='stripe' AND COALESCE(s.provider_subscription_id,'') LIKE 'sub\\_%' ESCAPE '\\')
        OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') LIKE 'I-%'))
    GROUP BY b.bucket,COALESCE(s.currency_snapshot,p.currency,'GBP')
    ORDER BY b.bucket`,[range.start,range.end]);
  const target=reportingCurrency.cleanCurrency(reporting?.currency||'GBP');
  const buckets=emptySeries(range,grain).map(point=>({...point,mrr_minor:0})),byKey=new Map(buckets.map(row=>[row.key,row]));
  for(const row of result.rows){const point=byKey.get(keyFor(row.bucket,grain));if(point)point.mrr_minor+=reportingCurrency.convertMinor(Number(row.mrr_minor||0),row.currency||target,target,reporting);}
  return{grain,currency:target,rows:buckets,current:buckets.at(-1)?.mrr_minor||0};
}

async function playbackTrend(range) {
  const grain=playbackGrain(range),step=grainInterval(grain);
  const result=await query(`WITH buckets AS (
      SELECT gs AS bucket,GREATEST(gs,$1::timestamptz) bucket_start,LEAST(gs+INTERVAL '${step}',$2::timestamptz) bucket_end
      FROM generate_series(date_trunc('${grain}',$1::timestamptz),date_trunc('${grain}',($2::timestamptz-INTERVAL '1 microsecond')),INTERVAL '${step}') gs
    ), overlaps AS (
      SELECT b.bucket,b.bucket_start,b.bucket_end,ph.id,LOWER(COALESCE(ph.playback_method,'unknown')) method,
        CASE WHEN ph.id IS NULL THEN 0 ELSE GREATEST(0,EXTRACT(EPOCH FROM (LEAST(COALESCE(ph.ended_at,ph.last_seen_at),b.bucket_end)-GREATEST(ph.started_at,b.bucket_start)))) END seconds,
        CASE WHEN ph.id IS NOT NULL AND ph.started_at>=b.bucket_start AND ph.started_at<b.bucket_end THEN 1 ELSE 0 END started
      FROM buckets b LEFT JOIN playback_history ph
        ON ph.started_at<b.bucket_end AND COALESCE(ph.ended_at,ph.last_seen_at)>b.bucket_start
    )
    SELECT bucket,
      COALESCE(SUM(seconds)/NULLIF(EXTRACT(EPOCH FROM(MAX(bucket_end)-MIN(bucket_start))),0),0)::numeric avg_concurrent,
      SUM(started)::int session_starts,
      COALESCE(SUM(seconds) FILTER(WHERE method='directplay'),0)::bigint directplay_seconds,
      COALESCE(SUM(seconds) FILTER(WHERE method='directstream'),0)::bigint directstream_seconds,
      COALESCE(SUM(seconds) FILTER(WHERE method='transcode'),0)::bigint transcode_seconds,
      COALESCE(SUM(seconds) FILTER(WHERE method NOT IN('directplay','directstream','transcode')),0)::bigint unknown_seconds
    FROM overlaps GROUP BY bucket ORDER BY bucket`,[range.start,range.end]);
  const rows=fillPlaybackSeries(range,grain,result.rows,['avg_concurrent','session_starts','directplay_seconds','directstream_seconds','transcode_seconds','unknown_seconds']).map(row=>{
    const total=row.directplay_seconds+row.directstream_seconds+row.transcode_seconds+row.unknown_seconds;
    return{...row,directplay_pct:total?row.directplay_seconds/total*100:0,directstream_pct:total?row.directstream_seconds/total*100:0,transcode_pct:total?row.transcode_seconds/total*100:0,unknown_pct:total?row.unknown_seconds/total*100:0};
  });
  return{grain,rows,current:rows.at(-1)?.avg_concurrent||0};
}

function normalizePlayer(client,device) {
  const raw=[client,device].filter(Boolean).join(' '),value=raw.toLowerCase();
  if(!value)return'Unknown';
  if(value.includes('stremio'))return'Stremio';
  if(value.includes('infuse'))return'Infuse';
  if(value.includes('roku'))return'Roku';
  if(value.includes('tizen')||value.includes('samsung'))return'Samsung TV';
  if(value.includes('webos')||value.includes('lg '))return'LG TV';
  if(value.includes('android tv')||value.includes('shield')||value.includes('fire tv'))return'Android TV';
  if(value.includes('iphone')||value.includes('ipad')||value.includes('ios'))return'iPhone / iPad';
  if(value.includes('android'))return'Android Mobile';
  if(value.includes('web')||value.includes('chrome')||value.includes('firefox')||value.includes('safari')||value.includes('edge'))return'Web';
  return String(client||device||'Other').slice(0,42);
}
async function playerUsage(range) {
  const result=await query(`SELECT client_name,device_name,COUNT(*)::int sessions,
      COUNT(DISTINCT customer_id)::int users,
      COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at)))),0)::bigint seconds
    FROM playback_history
    WHERE started_at>=$1 AND started_at<$2
    GROUP BY client_name,device_name`,[range.start,range.end]);
  const grouped=new Map();
  for(const row of result.rows){const name=normalizePlayer(row.client_name,row.device_name),current=grouped.get(name)||{name,sessions:0,seconds:0};current.sessions+=Number(row.sessions||0);current.seconds+=Number(row.seconds||0);grouped.set(name,current);}
  const rows=[...grouped.values()].sort((a,b)=>b.seconds-a.seconds||b.sessions-a.sessions).slice(0,9),total=rows.reduce((sum,row)=>sum+row.seconds,0);
  return{rows:rows.map(row=>({...row,share:total?row.seconds/total*100:0}))};
}

async function growthServerAnalytics(range,reporting) {
  const [growth,plans,mrr,playback,players]=await Promise.all([
    growthMovement(range),planTrend(range),mrrTrend(range,reporting),playbackTrend(range),playerUsage(range)
  ]);
  return{growth,plans,mrr,playback,players};
}

module.exports={PRIMARY_PAID,ACCESS_END,MONTHLY_EQUIVALENT,safeGrowthGrain,playbackGrain,grainInterval,labelFor,emptySeries,growthMovement,planTrend,mrrTrend,playbackTrend,normalizePlayer,playerUsage,growthServerAnalytics};
