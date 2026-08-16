'use strict';

const {query}=require('../db');
const reporting=require('./reporting-currency');
const {esc}=require('./admin-html');

function money(minor,currency){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency,maximumFractionDigits:0}).format(Number(minor||0)/100)}catch{return `${currency} ${(Number(minor||0)/100).toFixed(0)}`}}
function monday(value){const d=new Date(value),day=d.getUTCDay()||7;return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-day+1));}
function weekKey(value){return monday(value).toISOString().slice(0,10);}
function weekLabel(value){return monday(value).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});}
function addDays(date,days){return new Date(date.getTime()+days*86400000);}
function clamp(value,min,max){return Math.max(min,Math.min(max,value));}

async function data({weeks=12}={}){
  const fx=await reporting.refreshRates().catch(()=>reporting.get()),currency=fx.currency,now=new Date(),end=addDays(now,weeks*7);
  const [renewals,growthRows]=await Promise.all([
    query(`SELECT s.current_period_end,
        COALESCE(s.price_minor_snapshot,p.price_minor) price_minor,
        COALESCE(s.currency_snapshot,p.currency) currency
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.superseded_by IS NULL AND s.status IN('active','trialing','past_due')
        AND s.cancel_at_period_end=FALSE AND s.current_period_end>NOW() AND s.current_period_end<=$1
        AND COALESCE(s.price_minor_snapshot,p.price_minor)>0
        AND ((s.source='stripe' AND COALESCE(s.provider_subscription_id,'') LIKE 'sub\\_%' ESCAPE '\\')
          OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') LIKE 'I-%'))`,[end]),
    query(`SELECT s.created_at,
        COALESCE(s.price_minor_snapshot,p.price_minor) price_minor,
        COALESCE(s.currency_snapshot,p.currency) currency
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.created_at>=NOW()-INTERVAL '60 days'
        AND COALESCE(s.price_minor_snapshot,p.price_minor)>0
        AND s.source IN('stripe','paypal','manual')`)
  ]);
  const buckets=[];let cursor=monday(now);for(let i=0;i<weeks;i++,cursor=addDays(cursor,7))buckets.push({key:weekKey(cursor),label:weekLabel(cursor),renewalMinor:0,growthMinor:0});
  const map=new Map(buckets.map(x=>[x.key,x]));
  for(const row of renewals.rows){const b=map.get(weekKey(row.current_period_end));if(b)b.renewalMinor+=reporting.convertMinor(row.price_minor,row.currency,currency,fx);}
  const cutoff30=Date.now()-30*86400000,cutoff60=Date.now()-60*86400000;
  let recentCount=0,previousCount=0,recentValue=0,previousValue=0;
  for(const row of growthRows.rows){
    const at=new Date(row.created_at).getTime(),converted=reporting.convertMinor(row.price_minor,row.currency,currency,fx);
    if(at>=cutoff30){recentCount++;recentValue+=converted;}
    else if(at>=cutoff60){previousCount++;previousValue+=converted;}
  }
  const countTrend=previousCount?clamp((recentCount-previousCount)/previousCount,-.5,1):recentCount?0.15:0;
  const valueTrend=previousValue?clamp((recentValue-previousValue)/previousValue,-.5,1):recentValue?0.15:0;
  // Use both customer acquisition and commercial value movement. Averaging them
  // dampens a single unusually expensive purchase while still reflecting a
  // meaningful change in recent paid customer growth.
  const trend=clamp((countTrend+valueTrend)/2,-.5,1),weeklyBase=recentValue/30*7;
  buckets.forEach((bucket,index)=>{bucket.growthMinor=Math.max(0,Math.round(weeklyBase*Math.pow(1+trend,index/4)));bucket.totalMinor=bucket.renewalMinor+bucket.growthMinor;});
  const known=buckets.reduce((s,b)=>s+b.renewalMinor,0),prospect=buckets.reduce((s,b)=>s+b.growthMinor,0);
  return{currency,fxUpdatedAt:fx.updatedAt,fxSource:fx.source,weeks,buckets,knownRenewalsMinor:known,prospectGrowthMinor:prospect,totalMinor:known+prospect,recentCount,previousCount,recentValueMinor:recentValue,previousValueMinor:previousValue,trend};
}
function chart(f){const max=Math.max(1,...f.buckets.map(b=>b.totalMinor)),bars=f.buckets.map((b,i)=>{const totalH=Math.max(2,Math.round(b.totalMinor/max*116)),renewH=Math.round(b.renewalMinor/max*116),x=16+i*48,y=142-totalH;return `<g><rect x="${x}" y="${y}" width="30" height="${totalH}" rx="4" class="forecastGrowth"><title>${esc(b.label)} projected: ${esc(money(b.totalMinor,f.currency))}</title></rect>${renewH?`<rect x="${x}" y="${142-renewH}" width="30" height="${renewH}" rx="4" class="forecastKnown"><title>${esc(b.label)} known renewals: ${esc(money(b.renewalMinor,f.currency))}</title></rect>`:''}<text x="${x+15}" y="160" text-anchor="middle" class="forecastAxis">${esc(b.label)}</text></g>`}).join('');return `<div class="forecastChart"><svg viewBox="0 0 ${Math.max(620,32+f.buckets.length*48)} 172" role="img" aria-label="Prospective income forecast"><line x1="8" y1="142" x2="99%" y2="142" class="forecastBaseline"/>${bars}</svg></div>`;}
function render(f,csrfToken=''){const trendPct=Math.round(f.trend*100),fxAge=f.fxUpdatedAt?new Date(f.fxUpdatedAt).toLocaleString('en-GB'):'fallback rates';return `<section class="analyticsCard wide forecastCard"><div class="analyticsCardHeader"><div><h2>Prospective income</h2><p>Known automatic renewals + a separately modelled recent-growth estimate</p></div><div class="analyticsCardHeaderStat"><strong>${esc(money(f.totalMinor,f.currency))}</strong><span>12-week prospect</span></div></div><div class="analyticsCardBody"><div class="miniStats"><div class="miniStat"><strong class="statusGood">${esc(money(f.knownRenewalsMinor,f.currency))}</strong><span>known renewals</span></div><div class="miniStat"><strong class="statusInfo">${esc(money(f.prospectGrowthMinor,f.currency))}</strong><span>growth estimate</span></div><div class="miniStat"><strong class="${trendPct>=0?'statusGood':'statusWarn'}">${trendPct>=0?'+':''}${trendPct}%</strong><span>recent acquisition/value trend</span></div><div class="miniStat"><strong>${esc(f.currency)}</strong><span>reporting currency</span></div></div>${chart(f)}<div class="forecastLegend"><span><i class="known"></i> scheduled recurring renewals</span><span><i class="growth"></i> modelled new-business prospect</span></div><div class="analyticsFootnote">The growth portion is a forecast, not committed income. Every recent subscription is converted from its original GBP/USD/EUR value before modelling; the estimate compares the latest 30 days with the previous 30 days and bounds the trend to avoid unrealistic extrapolation. Original transaction currencies remain unchanged. FX refreshed ${esc(fxAge)}.</div><form class="reportingCurrency" method="post" action="/admin/reporting-currency"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><label>Dashboard currency <select class="input" name="currency">${reporting.CURRENCIES.map(c=>`<option value="${c}" ${c===f.currency?'selected':''}>${c}</option>`).join('')}</select></label><button class="button secondary btn-sm">Apply</button></form></div></section>`;}
module.exports={data,render,money,weekKey,clamp};
