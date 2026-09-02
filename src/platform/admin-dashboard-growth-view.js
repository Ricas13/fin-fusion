'use strict';

const { esc } = require('./admin-html');
const { number, money } = require('./admin-dashboard-format');

const W=620,H=214,L=44,R=14,T=16,B=30,PW=W-L-R,PH=H-T-B;
function fmt1(value){return Number(value||0).toLocaleString('en-GB',{maximumFractionDigits:1});}
function pct(value){return `${fmt1(value)}%`;}
function compact(value){const n=Number(value||0);if(Math.abs(n)>=1000000)return`${(n/1000000).toFixed(1)}m`;if(Math.abs(n)>=1000)return`${(n/1000).toFixed(n>=10000?0:1)}k`;return number(Math.round(n));}
function deltaPercent(current,previous){const a=Number(current||0),b=Number(previous||0);if(!b)return null;return(a-b)/Math.abs(b)*100;}
function metric(value,label='',delta=null,{inverse=false}={}){
  let badge='';
  if(delta!=null&&Number.isFinite(Number(delta))){const positive=inverse?delta<=0:delta>=0;badge=`<span class="growthDelta ${positive?'good':'bad'}">${delta>=0?'↑':'↓'} ${esc(Math.abs(delta).toFixed(1))}%</span>`;}
  return `<div class="growthMetric"><strong>${value}</strong><span>${esc(label)}</span>${badge}</div>`;
}
function legend(items){return `<div class="growthLegend">${items.map(([label,tone])=>`<span><i class="tone-${esc(tone)}"></i>${esc(label)}</span>`).join('')}</div>`;}
function labels(rows){if(!rows.length)return'';const every=Math.max(1,Math.ceil(rows.length/6)),step=rows.length<=1?PW:PW/(rows.length-1);return rows.map((row,i)=>{if(i!==0&&i!==rows.length-1&&i%every!==0)return'';const x=L+(rows.length<=1?PW/2:i*step);return`<text class="growthAxisText" x="${x.toFixed(1)}" y="${H-7}" text-anchor="middle">${esc(row.label)}</text>`;}).join('');}
function grid(min,max,formatter=compact){let out='';const span=Math.max(1,max-min);for(let i=0;i<=4;i++){const ratio=i/4,y=T+PH-PH*ratio,value=min+span*ratio;out+=`<line class="growthGrid" x1="${L}" x2="${W-R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="growthAxisText" x="${L-7}" y="${(y+3).toFixed(1)}" text-anchor="end">${esc(formatter(value))}</text>`;}return out;}
function empty(message='No data in this period.'){return`<div class="growthEmpty">${esc(message)}</div>`;}
function chartFrame(inner,label){return`<div class="growthChartFrame"><svg class="growthChart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${inner}</svg></div>`;}

function areaLine(rows,key,tone,formatter=compact,label='Trend'){
  if(!rows.length)return empty();const values=rows.map(row=>Number(row[key]||0));if(!values.some(Number.isFinite))return empty();
  const max=Math.max(1,...values),min=Math.min(0,...values),span=Math.max(1,max-min),step=rows.length<=1?PW:PW/(rows.length-1);
  const pts=values.map((v,i)=>[L+(rows.length<=1?PW/2:i*step),T+PH-(v-min)/span*PH]);
  const line=pts.map(([x,y])=>`${x.toFixed(1)},${y.toFixed(1)}`).join(' '),baseY=T+PH-(0-min)/span*PH,area=`${L},${baseY.toFixed(1)} ${line} ${W-R},${baseY.toFixed(1)}`;
  const dots=pts.map(([x,y],i)=>`<circle class="growthPoint tone-${tone}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"><title>${esc(rows[i].label)}: ${esc(formatter(values[i]))}</title></circle>`).join('');
  return chartFrame(`${grid(min,max,formatter)}<polygon class="growthArea tone-${tone}" points="${area}"/><polyline class="growthLine tone-${tone}" points="${line}"/>${dots}${labels(rows)}`,label);
}

function movementBars(rows){
  if(!rows.length)return empty();const positives=rows.map(r=>Number(r.new_customers||0)+Number(r.reactivations||0)),negatives=rows.map(r=>Number(r.churned||0)),max=Math.max(1,...positives,...negatives),half=PH/2,band=PW/Math.max(1,rows.length),barW=Math.max(4,Math.min(24,band*.52)),zero=T+half;
  const bars=rows.map((row,i)=>{const fresh=Number(row.new_customers||0),react=Number(row.reactivations||0),churn=Number(row.churned||0),x=L+i*band+(band-barW)/2,freshH=fresh/max*half,reactH=react/max*half,churnH=churn/max*half;return`<rect class="growthBar tone-green" x="${x.toFixed(1)}" y="${(zero-freshH).toFixed(1)}" width="${barW.toFixed(1)}" height="${freshH.toFixed(1)}"><title>${esc(row.label)} new: ${esc(number(fresh))}</title></rect><rect class="growthBar tone-teal" x="${x.toFixed(1)}" y="${(zero-freshH-reactH).toFixed(1)}" width="${barW.toFixed(1)}" height="${reactH.toFixed(1)}"><title>${esc(row.label)} reactivated: ${esc(number(react))}</title></rect><rect class="growthBar tone-red" x="${x.toFixed(1)}" y="${zero.toFixed(1)}" width="${barW.toFixed(1)}" height="${churnH.toFixed(1)}"><title>${esc(row.label)} churned: ${esc(number(churn))}</title></rect>`;}).join('');
  const axisLabels=rows.map((row,i)=>{const every=Math.max(1,Math.ceil(rows.length/6));if(i!==0&&i!==rows.length-1&&i%every!==0)return'';const x=L+i*band+band/2;return`<text class="growthAxisText" x="${x.toFixed(1)}" y="${H-7}" text-anchor="middle">${esc(row.label)}</text>`;}).join('');
  return chartFrame(`<line class="growthGrid growthZero" x1="${L}" x2="${W-R}" y1="${zero}" y2="${zero}"/>${bars}${axisLabels}`,'New customers, reactivations and churn');
}
function signedBars(rows,key){
  if(!rows.length)return empty();const values=rows.map(r=>Number(r[key]||0)),max=Math.max(1,...values.map(Math.abs)),band=PW/Math.max(1,rows.length),barW=Math.max(4,Math.min(28,band*.58)),zero=T+PH/2;
  const bars=rows.map((row,i)=>{const value=values[i],h=Math.abs(value)/max*(PH/2),x=L+i*band+(band-barW)/2,y=value>=0?zero-h:zero,tone=value>=0?'green':'red';return`<rect class="growthBar tone-${tone}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(row.label)}: ${value>=0?'+':''}${esc(number(value))}</title></rect>`;}).join('');
  const axisLabels=rows.map((row,i)=>{const every=Math.max(1,Math.ceil(rows.length/6));if(i!==0&&i!==rows.length-1&&i%every!==0)return'';return`<text class="growthAxisText" x="${(L+i*band+band/2).toFixed(1)}" y="${H-7}" text-anchor="middle">${esc(row.label)}</text>`;}).join('');
  return chartFrame(`<line class="growthGrid growthZero" x1="${L}" x2="${W-R}" y1="${zero}" y2="${zero}"/>${bars}${axisLabels}`,'Net subscriber growth');
}
function stackedArea(rows,series){
  if(!rows.length||!series.length)return empty();const totals=rows.map(row=>series.reduce((sum,s)=>sum+Number(row[s.key]||0),0)),max=Math.max(1,...totals),step=rows.length<=1?PW:PW/(rows.length-1),x=i=>L+(rows.length<=1?PW/2:i*step),y=v=>T+PH-v/max*PH;let cumulative=rows.map(()=>0);
  const layers=series.map((s,index)=>{const next=rows.map((r,i)=>cumulative[i]+Number(r[s.key]||0)),top=next.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),bottom=[...cumulative].reverse().map((v,ri)=>{const i=rows.length-1-ri;return`${x(i).toFixed(1)},${y(v).toFixed(1)}`;}).join(' ');cumulative=next;return`<polygon class="growthStack tone-series-${index}" points="${top} ${bottom}"></polygon>`;}).join('');
  const hovers=rows.map((row,i)=>`<rect class="growthHover" x="${Math.max(L,x(i)-Math.max(6,step/2)).toFixed(1)}" y="${T}" width="${Math.max(12,step).toFixed(1)}" height="${PH}"><title>${esc(row.label)} · ${series.map(s=>`${s.label}: ${number(row[s.key]||0)}`).join(' · ')}</title></rect>`).join('');
  return chartFrame(`${grid(0,max,compact)}${layers}${hovers}${labels(rows)}`,'Subscriptions by plan');
}
function percentStacked(rows,series){
  if(!rows.length)return empty();const step=rows.length<=1?PW:PW/(rows.length-1),x=i=>L+(rows.length<=1?PW/2:i*step),y=v=>T+PH-v/100*PH;let cumulative=rows.map(()=>0);
  const layers=series.map((s,index)=>{const next=rows.map((r,i)=>cumulative[i]+Number(r[s.key]||0)),top=next.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),bottom=[...cumulative].reverse().map((v,ri)=>{const i=rows.length-1-ri;return`${x(i).toFixed(1)},${y(v).toFixed(1)}`;}).join(' ');cumulative=next;return`<polygon class="growthStack tone-method-${index}" points="${top} ${bottom}"></polygon>`;}).join('');
  const hovers=rows.map((row,i)=>`<circle class="growthHoverPoint" cx="${x(i).toFixed(1)}" cy="${T+PH/2}" r="9"><title>${esc(row.label)} · ${series.map(s=>`${s.label}: ${pct(row[s.key]||0)}`).join(' · ')}</title></circle>`).join('');
  return chartFrame(`${grid(0,100,v=>`${Math.round(v)}%`)}${layers}${hovers}${labels(rows)}`,'Playback method share');
}
function playerBars(rows){if(!rows.length)return empty('No managed playback history in this period.');const max=Math.max(1,...rows.map(r=>Number(r.seconds||0)));return`<div class="playerBars">${rows.map((row,index)=>`<div class="playerBar"><span>${esc(row.name)}</span><div class="playerTrack"><i class="tone-player-${index}" style="width:${Math.max(2,Number(row.seconds||0)/max*100).toFixed(1)}%"></i></div><strong>${esc(pct(row.share))}</strong><small>${esc(number(row.sessions))} plays</small></div>`).join('')}</div>`;}
function foot(text){return`<div class="growthFoot">${esc(text)}</div>`;}
function sum(rows,key){return(rows||[]).reduce((total,row)=>total+Number(row[key]||0),0);}
function lastNonNull(rows,key){for(let i=rows.length-1;i>=0;i--){const value=rows[i]?.[key];if(value!=null&&Number.isFinite(Number(value)))return Number(value);}return null;}

function activeSubscribers(data){const rows=data.growth.rows,current=data.growth.current,delta=deltaPercent(current,data.growth.baseline);return`${metric(number(current),'paid customers at end of period',delta)}${areaLine(rows,'active_subscribers','amber',compact,'Active subscribers')}${foot('Customer-level paid access; plan switches do not create false churn.')}`;}
function newVsChurn(data){const rows=data.growth.rows,newCount=sum(rows,'new_customers'),reactivated=sum(rows,'reactivations'),churn=sum(rows,'churned'),net=newCount+reactivated-churn;return`${metric(`${net>=0?'+':''}${number(net)}`,'net active movement')}${legend([['New','green'],['Reactivated','teal'],['Churned','red']])}${movementBars(rows)}${foot('First activations and returning customers are separated so the totals reconcile.')}`;}
function netGrowth(data){const rows=data.growth.rows,total=sum(rows,'net_growth');return`${metric(`${total>=0?'+':''}${number(total)}`,'net growth over selected range')}${signedBars(rows,'net_growth')}${foot('Activations + reactivations − customers whose paid access ended.')}`;}
function subscriptionsByPlan(data){const rows=data.plans.rows,series=data.plans.series,current=rows.at(-1)||{},total=series.reduce((sum,s)=>sum+Number(current[s.key]||0),0);return`${metric(number(total),'active paid subscriptions')}${legend(series.map((s,i)=>[s.label,`series-${i}`]))}${stackedArea(rows,series)}${foot('Subscription-level view; add-ons are excluded so plan switching stays readable.')}`;}
function churnRate(data){const rows=data.growth.rows,current=lastNonNull(rows,'churn_rate'),first=rows.find(r=>r.churn_rate!=null)?.churn_rate??null,delta=current!=null&&first!=null?current-first:null;return`${metric(current==null?'—':pct(current),'churn / active customers at bucket start',delta,{inverse:true})}${areaLine(rows.map(r=>({...r,churn_rate:r.churn_rate??0})),'churn_rate','yellow',pct,'Churn rate')}${foot('Opening-customer denominator; cancellation requests count only when paid access actually ends.')}`;}
function mrr(data){const rows=data.mrr.rows,current=data.mrr.current,first=rows[0]?.mrr_minor||0,delta=deltaPercent(current,first);return`${metric(money(current,data.mrr.currency),`recurring MRR · ${data.mrr.currency}`,delta)}${areaLine(rows,'mrr_minor','green',v=>money(v,data.mrr.currency),'Monthly recurring revenue')}${foot('Verified recurring Stripe/PayPal contracts only; prepaid cash is not disguised as MRR.')}`;}
function activeStreams(data){const rows=data.playback.rows,totalSeconds=sum(rows,'bucket_seconds'),weighted=totalSeconds?rows.reduce((s,r)=>s+Number(r.avg_concurrent||0)*Number(r.bucket_seconds||0),0)/totalSeconds:0,totalStarts=sum(rows,'session_starts');return`${metric(fmt1(weighted),`average concurrent streams · ${number(totalStarts)} starts`)}${areaLine(rows,'avg_concurrent','cyan',fmt1,'Average concurrent streams')}${foot(`Playback overlap by ${data.playback.grain}; long streams contribute proportionally to actual load.`)}`;}
function playMethods(data){const rows=data.playback.rows,series=[{key:'directplay_pct',label:'Direct Play'},{key:'directstream_pct',label:'Direct Stream'},{key:'transcode_pct',label:'Transcode'}];const seconds={direct:sum(rows,'directplay_seconds'),stream:sum(rows,'directstream_seconds'),transcode:sum(rows,'transcode_seconds')},known=seconds.direct+seconds.stream+seconds.transcode,transPct=known?seconds.transcode/known*100:0;return`${metric(pct(transPct),'transcoded watch time')}${legend([['Direct Play','green'],['Direct Stream','blue'],['Transcode','purple']])}${percentStacked(rows,series)}${foot('Based on watch-time overlap, not just how a session happened to start.')}`;}
function players(data){const rows=data.players.rows,totalHours=Number(data.players.totalSeconds||0)/3600;return`${metric(`${fmt1(totalHours)}h`,'total managed watch time')}${playerBars(rows)}${foot('Clients are normalized into stable player families; displayed shares use all managed player watch time as the denominator.')}`;}

module.exports={deltaPercent,areaLine,movementBars,signedBars,stackedArea,percentStacked,playerBars,activeSubscribers,newVsChurn,netGrowth,subscriptionsByPlan,churnRate,mrr,activeStreams,playMethods,players};
