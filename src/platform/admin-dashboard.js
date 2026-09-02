'use strict';

const { esc, layout } = require('./admin-html');
const { renderMain } = require('./admin-dashboard-main');
const { rangeControls } = require('./admin-dashboard-view');
const { dashboardData } = require('./admin-dashboard-data');
const { dashboardRange } = require('./admin-dashboard-analytics');
const reportingCurrency = require('./reporting-currency');
const runtimeSettings = require('./runtime-settings');
const { money, number } = require('./admin-dashboard-format');

function isNativeAdmin(req){return Boolean(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId);}
function primaryAction(stats){if(!stats.setup?.counts?.plans)return'<a class="button" href="/admin/plans">+ Create plan</a>';if(!stats.setup?.counts?.servers)return'<a class="button" href="/admin/servers/new">+ Add server</a>';return'<a class="button" href="/admin/users/new">+ Add customer</a>';}
function messageBlock(req){return`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`;}
function percentDelta(current,previous){const a=Number(current||0),b=Number(previous||0);if(!b)return null;return((a-b)/Math.abs(b))*100;}
function profitDelta(profit,currency){const current=Number(profit.current?.profitMinor||0),previous=Number(profit.previous?.profitMinor||0),delta=current-previous,pct=percentDelta(current,previous),kind=delta>=0?'good':'bad',direction=delta>=0?'up':'down';return`<span class="profitDelta ${kind}">${direction} ${esc(money(Math.abs(delta),currency))}${pct==null?'':` · ${Math.abs(pct).toFixed(1)}%`} vs last month</span>`;}
function dashboardHero(ctx){
  const stats=ctx.data||{},profit=stats.profitability||{},currency=profit.currency||ctx.reporting?.currency||'GBP',current=Number(profit.current?.profitMinor||0),ytd=Number(profit.ytd?.profitMinor||0),gauge=stats.streamGauge||{active:0,capacity:0},active=Number(gauge.active||0),capacity=Number(gauge.capacity||0),attention=Number(stats.attention?.count||0),used=capacity>0?Math.min(100,Math.max(0,Math.round(active/capacity*100))):0,basis=profit.ytd?.basisText||'Net provider receipts (imported history + webhooks) minus booked expenses. Bank payouts are transfers, not costs.';
  return `<section class="profitHeroGrid" aria-label="Business and operational summary">
    <a class="profitHeroCard profitHeroCard--profit ${current>=0&&ytd>=0?'good':'bad'}" href="/admin/expenses" title="${esc(basis)}"><span>Profit</span><div class="profitMetricPair"><div><small>Profit this month</small><strong>${esc(money(current,currency))}</strong><em>${profitDelta(profit,currency)}</em></div><div><small>Profit YTD</small><strong>${esc(money(ytd,currency))}</strong><em>Net provider receipts minus booked expenses</em></div></div></a>
    <a class="profitHeroCard info" href="/admin/servers"><span>Live streams</span><strong>${esc(number(active))} / ${capacity?esc(number(capacity)):'—'}</strong><div class="profitGauge" aria-hidden="true"><i style="width:${used}%"></i></div><small>used / sellable stream capacity</small></a>
    <a class="profitHeroCard ${attention>0?'bad':'good'}" href="/admin/attention"><span>Needs attention</span><strong>${esc(number(attention))}</strong><small>${attention?`${attention} current ${attention===1?'issue':'issues'} require review`:'No current intervention required'}</small></a>
  </section><div class="subText profitBasisText">${esc(basis)}</div>`;
}

async function dashboardPage(req,res){
  if(!isNativeAdmin(req))return res.redirect('/login?session=expired');
  res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');
  try{
    await Promise.all([runtimeSettings.ensureLoaded(),reportingCurrency.refreshRates().catch(()=>null)]);
    const{ctx,html}=await renderMain(req),stats=ctx.data;
    const body=`<div class="adminDashboardCompactBody">${messageBlock(req)}${dashboardHero(ctx)}${rangeControls(ctx.range)}${html}</div>`;
    return res.send(layout({siteName:runtimeSettings.siteName(),active:'dashboard',title:'Admin Dashboard',subtitle:`Profit, growth and live capacity · ${ctx.range.label} · ${ctx.reporting.currency}`,body,action:primaryAction(stats)}));
  }catch(error){
    console.error('Admin dashboard failed:',error.message);
    return res.status(500).render('auth/message',{siteName:runtimeSettings.siteName(),title:'Dashboard unavailable',message:'The administration dashboard could not be loaded safely.',link:'/admin/setup',linkText:'Open Setup'});
  }
}

module.exports={dashboardPage,dashboardData,primaryAction,dashboardRange,dashboardHero,profitDelta,percentDelta};
