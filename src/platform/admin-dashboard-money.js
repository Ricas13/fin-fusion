'use strict';

const {query}=require('../db');
const dashboardLedger=require('../payments/dashboard-ledger');
const reportingCurrency=require('./reporting-currency');
const {bucketKey,delta}=require('./admin-dashboard-analytics');

function inWindow(at,start,end){return at>=start&&at<end;}
function convert(minor,currency,target,state){return reportingCurrency.convertMinor(Number(minor||0),String(currency||target).toUpperCase(),target,state);}

async function normalizedDashboardMoney(range,seriesSkeleton,reporting){
  const target=reportingCurrency.cleanCurrency(reporting?.currency||'GBP');
  const accounting=await dashboardLedger.accountingRecords(range);
  const current=[],previous=[],sourceTotals=new Map();
  for(const row of accounting.records){
    if(row.kind!=='payment')continue;
    const at=new Date(row.createdAt),originalMinor=Number(row.minor||0),originalCurrency=String(row.currency||target).toUpperCase(),normalizedMinor=convert(originalMinor,originalCurrency,target,reporting);
    const record={...row,originalMinor,originalCurrency,minor:normalizedMinor,currency:target,createdAt:at};
    if(inWindow(at,range.start,range.end)){current.push(record);sourceTotals.set(originalCurrency,(sourceTotals.get(originalCurrency)||0)+originalMinor);}
    else if(inWindow(at,range.previousStart,range.previousEnd))previous.push(record);
  }
  const totalMinor=current.reduce((sum,row)=>sum+row.minor,0),previousMinor=previous.reduce((sum,row)=>sum+row.minor,0);
  const series=(seriesSkeleton||[]).map(point=>({...point,revenue_minor:0})),byKey=new Map(series.map(point=>[point.key,point]));
  for(const record of current){const point=byKey.get(bucketKey(record.createdAt,range.bucket));if(point)point.revenue_minor+=record.minor;}

  const forecastEnd=new Date(Date.now()+range.days*86400000);
  const renewals=await query(`
      SELECT s.id,s.customer_id,s.source,s.current_period_end,s.cancel_at_period_end,
             COALESCE(s.plan_name_snapshot,p.name) plan_name,
             COALESCE(s.price_minor_snapshot,p.price_minor) price_minor,
             COALESCE(s.currency_snapshot,p.currency) currency,
             COALESCE(c.display_name,u.username,c.email,'Customer') name
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      JOIN customers c ON c.id=s.customer_id
      LEFT JOIN app_users u ON u.id=c.user_id
      WHERE s.status IN ('active','trialing') AND s.cancel_at_period_end=FALSE
        AND s.current_period_end > NOW() AND s.current_period_end <= $1
        AND ((s.source='stripe' AND s.provider_subscription_id LIKE 'sub\\_%' ESCAPE '\\') OR (s.source='paypal' AND s.provider_subscription_id LIKE 'I-%'))
      ORDER BY s.current_period_end LIMIT 1000
  `,[forecastEnd]);
  const convertedRenewals=renewals.rows.map(row=>({...row,original_price_minor:Number(row.price_minor||0),original_currency:String(row.currency||target).toUpperCase(),price_minor:convert(row.price_minor,row.currency,target,reporting),currency:target}));
  const renewalMinor=convertedRenewals.reduce((sum,row)=>sum+Number(row.price_minor||0),0);

  return{
    revenue:{primaryCurrency:target,totalMinor,previousMinor,currencies:[{currency:target,minor:totalMinor}],sourceCurrencies:[...sourceTotals.entries()].map(([currency,minor])=>({currency,minor})),series,recent:current.sort((a,b)=>b.createdAt-a.createdAt).slice(0,12),coverage:accounting.coverage},
    revenueDelta:delta(totalMinor,previousMinor),
    renewals:convertedRenewals.slice(0,12),
    renewalCount:convertedRenewals.length,
    renewalTotals:renewalMinor?[{currency:target,minor:renewalMinor}]:[],
    forecastDays:range.days,
    reportingCurrency:target
  };
}

module.exports={normalizedDashboardMoney};
