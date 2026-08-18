'use strict';
const {esc}=require('./admin-html');

function number(value,digits=0){return Number(value||0).toLocaleString('en-GB',{maximumFractionDigits:digits})}
function pct(value,max){const n=Number(value||0),m=Math.max(1,Number(max||0));return Math.max(0,Math.min(100,n/m*100))}
function toneClass(tone=''){return ['good','warn','bad','accent','violet','blue'].includes(tone)?tone:''}
function stat({label,value,meta='',tone='',href=''}) {
  const inner=`<div class="sectionStatLabel">${esc(label)}</div><div class="sectionStatValue">${esc(value)}</div>${meta?`<div class="sectionStatMeta">${esc(meta)}</div>`:''}`;
  return href?`<a class="sectionStat ${toneClass(tone)}" href="${esc(href)}">${inner}</a>`:`<div class="sectionStat ${toneClass(tone)}">${inner}</div>`;
}
function meter({label,value,max,tone='',meta=''}) {
  const width=pct(value,max).toFixed(1);
  return `<div class="sectionMeter ${toneClass(tone)}"><div class="sectionMeterTop"><strong>${esc(label)}</strong><span>${esc(number(value))}${max!=null?` / ${esc(number(max))}`:''}</span></div><div class="sectionMeterTrack"><span style="width:${width}%"></span></div>${meta?`<div class="sectionStatMeta">${esc(meta)}</div>`:''}</div>`;
}
function bars(rows,{label='name',value='count',href='' }={}) {
  if(!rows?.length)return'<div class="analyticsEmpty">No data yet.</div>';
  const max=Math.max(1,...rows.map(row=>Number(row[value]||0)));
  return `<div class="sectionBars">${rows.map(row=>{const url=typeof href==='function'?href(row):'';const text=`<strong>${esc(row[label]||'Unknown')}</strong><div class="sectionMeterTrack"><span style="width:${Math.max(2,Number(row[value]||0)/max*100).toFixed(1)}%"></span></div><em>${esc(number(row[value]))}</em>`;return url?`<a class="sectionBar" href="${esc(url)}">${text}</a>`:`<div class="sectionBar">${text}</div>`}).join('')}</div>`;
}
function hero({title,subtitle,stats=[],meters=[],tone='accent',actions=''}) {
  return `<section class="sectionGraphicHero ${toneClass(tone)}"><div><div class="sectionGraphicKicker">Section overview</div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p>${actions?`<div class="buttonRow">${actions}</div>`:''}</div><div class="sectionGraphicStats">${stats.join('')}${meters.join('')}</div></section>`;
}
function insightGrid(cards=[]) {
  return `<div class="sectionInsightGrid">${cards.map(card=>`<section class="sectionInsightCard ${toneClass(card.tone)}"><div class="sectionInsightHeader"><div><h3>${esc(card.title)}</h3>${card.subtitle?`<p>${esc(card.subtitle)}</p>`:''}</div>${card.value?`<strong>${esc(card.value)}</strong>`:''}</div>${card.body||''}${card.href?`<a class="sectionInsightLink" href="${esc(card.href)}">${esc(card.linkLabel||'Open')}</a>`:''}</section>`).join('')}</div>`;
}

module.exports={number,pct,stat,meter,bars,hero,insightGrid};
