'use strict';

const moneyFormat=require('./money-format');

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const affiliateCredits=require('../affiliate-credits');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');
const {sendCsv}=require('./export');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function csrfInput(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`;}
function money(minor,currency){return moneyFormat.formatMinor(minor,currency||'GBP');}
function balanceText(row){const balances=Array.isArray(row.balances)?row.balances:[];if(!balances.length)return'No credit yet';return balances.map(b=>`${b.currency}: ${money(b.available_minor,b.currency)} available · ${money(b.pending_minor,b.currency)} pending · ${money(b.lifetime_earned_minor,b.currency)} referral rewards`).join(' | ');}
function currencyTotals(balances,key){const grouped=new Map();for(const row of balances){const currency=String(row.currency||'GBP').toUpperCase();grouped.set(currency,(grouped.get(currency)||0)+Number(row[key]||0));}return [...grouped.entries()].filter(([,amount])=>amount!==0).map(([currency,amount])=>money(amount,currency)).join(' + ')||'—';}
function balanceTotal(balances,key){return (Array.isArray(balances)?balances:[]).reduce((sum,row)=>sum+Number(row[key]||0),0);}
function displayDate(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});}
function majorToMinor(value){const raw=String(value??'').trim();if(!/^-?\d+(?:\.\d{1,2})?$/.test(raw))throw new Error('Enter the credit adjustment as an amount such as 10.00 or -5.00.');const minor=Math.round(Number(raw)*100);if(!Number.isSafeInteger(minor)||minor===0)throw new Error('Enter a non-zero credit adjustment.');return minor;}
function rewardPreview(row,settings){const metadata=row.credit_metadata&&typeof row.credit_metadata==='object'?row.credit_metadata:{};const paidMinor=Number(metadata.paidMinor);if(!Number.isInteger(paidMinor)||paidMinor<=0||!row.credit_id)return null;const originalMinor=Number(row.amount_minor||0),topUps=Number(row.top_up_minor||0),grantedMinor=originalMinor+topUps,targetMinor=Math.max(1,Math.floor(paidMinor*settings.rewardPercent/100));return{paidMinor,originalMinor,topUps,grantedMinor,targetMinor,topUpMinor:Math.max(0,targetMinor-grantedMinor),originalPercent:Number(metadata.rewardPercent||0)||null};}

async function affiliateRows(){
  const r=await query(`SELECT c.id,c.display_name,c.email,rc.code,ap.active,ap.enrolled_at,COALESCE(bal.balances,'[]'::jsonb) balances
    FROM affiliate_profiles ap JOIN customers c ON c.id=ap.customer_id LEFT JOIN referral_codes rc ON rc.customer_id=c.id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('currency',x.currency,'available_minor',x.available_minor,'pending_minor',x.pending_minor,'lifetime_earned_minor',x.lifetime_earned_minor) ORDER BY x.currency) balances
      FROM (SELECT currency,COALESCE(SUM(amount_minor) FILTER(WHERE state='available'),0)::int available_minor,COALESCE(SUM(amount_minor) FILTER(WHERE state='pending'),0)::int pending_minor,COALESCE(SUM(amount_minor) FILTER(WHERE entry_type='earned' AND state<>'void'),0)::int lifetime_earned_minor FROM affiliate_credit_ledger WHERE customer_id=c.id GROUP BY currency) x
    ) bal ON TRUE ORDER BY ap.enrolled_at DESC LIMIT 500`);
  return r.rows.map(row=>({...row,balance_summary:balanceText(row)}));
}

async function redemptionRows(){
  const r=await query(`SELECT rr.id,rr.status,rr.reward_note,rr.rewarded_at,rr.created_at,rc.code referral_code,
      referrer.id referrer_id,referrer.display_name referrer_name,referred.display_name referred_name,
      l.id credit_id,l.amount_minor,l.currency,l.state credit_state,l.available_at,l.metadata credit_metadata,
      COALESCE(adj.top_up_minor,0)::int top_up_minor
    FROM referral_redemptions rr
    JOIN referral_codes rc ON rc.id=rr.referral_code_id
    JOIN customers referrer ON referrer.id=rc.customer_id
    JOIN customers referred ON referred.id=rr.referred_customer_id
    LEFT JOIN affiliate_credit_ledger l ON l.referral_redemption_id=rr.id AND l.entry_type='earned'
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.amount_minor),0)::int top_up_minor
      FROM affiliate_credit_ledger a
      WHERE l.id IS NOT NULL AND a.entry_type='adjustment' AND a.state<>'void'
        AND a.metadata->>'sourceRewardId'=l.id::text
    ) adj ON TRUE
    ORDER BY rr.created_at DESC LIMIT 500`);
  return r.rows;
}

function buildPerformanceRows(affiliates,redemptions){
  const grouped=new Map();
  for(const row of redemptions){const key=String(row.referrer_id||'');if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}
  return affiliates.map(affiliate=>{
    const referrals=grouped.get(String(affiliate.id))||[];
    const balances=Array.isArray(affiliate.balances)?affiliate.balances:[];
    const availableMinor=balanceTotal(balances,'available_minor');
    const pendingMinor=balanceTotal(balances,'pending_minor');
    const lifetimeMinor=balanceTotal(balances,'lifetime_earned_minor');
    const qualifiedCount=referrals.filter(row=>row.credit_id&&row.credit_state!=='void').length;
    let status='No referrals',statusTone='';
    if(affiliate.active===false){status='Programme disabled';statusTone='warn';}
    else if(availableMinor>0){status='Credit available';statusTone='good';}
    else if(pendingMinor>0){status='Credit pending';statusTone='accent';}
    else if(referrals.length){status='Referring';statusTone='good';}
    return {...affiliate,referrals,referral_count:referrals.length,qualified_count:qualifiedCount,available_text:currencyTotals(balances,'available_minor'),pending_text:currencyTotals(balances,'pending_minor'),lifetime_text:currencyTotals(balances,'lifetime_earned_minor'),available_sort:availableMinor,pending_sort:pendingMinor,lifetime_sort:lifetimeMinor,last_referral_at:referrals[0]?.created_at||null,status,status_tone:statusTone};
  });
}

function adjustmentForm(req,affiliate){return `<details class="affiliateAdjust"><summary>Adjust service credit</summary><form class="formPanel compact" method="post" action="/admin/referrals/${encodeURIComponent(affiliate.id)}/adjust-credit">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Amount</label><input class="input" name="amount" inputmode="decimal" placeholder="10.00 or -5.00" required><div class="inlineHelp">Positive adds immediately spendable credit; negative removes currently spendable credit.</div></div><div class="formGroup"><label>Currency</label><select class="input" name="currency"><option>GBP</option><option>USD</option><option>EUR</option></select></div><div class="formGroup span2"><label>Reason</label><input class="input" name="reason" maxlength="500" placeholder="Why is this correction required?" required></div></div><button class="button secondary" type="submit">Apply credit adjustment</button></form></details>`;}

function referralDetail(req,row,settings){
  const preview=rewardPreview(row,settings);
  const reward=row.amount_minor?`${esc(money(row.amount_minor,row.currency))}${Number(row.top_up_minor||0)>0?` + ${esc(money(row.top_up_minor,row.currency))} top-up`:''}`:'—';
  let correction='';
  if(preview&&preview.topUpMinor>0&&row.status==='rewarded'&&row.credit_state!=='void'){
    correction=`<form class="formPanel compact affiliateTopUp" method="post" action="/admin/referrals/rewards/${encodeURIComponent(row.credit_id)}/top-up">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Historical reward correction</label><div class="inlineHelp">Qualifying payment ${esc(money(preview.paidMinor,row.currency))}. Top up by <strong>${esc(money(preview.topUpMinor,row.currency))}</strong> to reach the current ${esc(settings.rewardPercent)}% rate.</div></div><div class="formGroup"><label>Reason</label><input class="input" name="reason" maxlength="500" value="Backfill referral reward to current ${esc(settings.rewardPercent)}% rate" required></div></div><button class="button secondary" type="submit">Top up to current rate</button></form>`;
  }
  const tone=row.status==='rewarded'?'good':row.status==='unfulfilled'||row.status==='reversed'?'warn':'accent';
  return `<div class="referralHistoryItem"><div class="referralHistoryMain"><div><strong>${esc(row.referred_name||'Customer')}</strong><span>${esc(displayDate(row.created_at))}${row.available_at?` · available ${esc(displayDate(row.available_at))}`:''}</span></div><span class="pill ${tone}">${esc(row.status||'unknown')}</span><div class="referralReward"><strong>${reward}</strong><span>${esc(row.credit_state||'No credit yet')}</span></div></div>${preview?`<div class="referralMeta">Qualifying payment ${esc(money(preview.paidMinor,row.currency))} · original rate ${preview.originalPercent?`${esc(preview.originalPercent)}%`:'not recorded'} · current programme ${esc(settings.rewardPercent)}%</div>`:''}${row.reward_note?`<div class="referralMeta">${esc(row.reward_note)}</div>`:''}${correction}</div>`;
}

function affiliateDetail(req,row,settings){
  const history=row.referrals.length?`<div class="referralHistory">${row.referrals.map(referral=>referralDetail(req,referral,settings)).join('')}</div>`:'<div class="empty affiliateEmpty">No referral activity for this customer yet.</div>';
  return `<div class="affiliateDetailInner"><div class="affiliateDetailHead"><div><strong>Referral activity</strong><span>${row.referral_count} referral${row.referral_count===1?'':'s'} · original earned rewards remain immutable</span></div>${adjustmentForm(req,row)}</div>${history}</div>`;
}

function affiliateTable(req,rows,settings){
  if(!rows.length)return'<div class="empty">No affiliate accounts yet.</div>';
  const bodies=rows.map((row,index)=>{
    const search=[row.display_name,row.email,row.code].filter(Boolean).join(' ').toLowerCase();
    return `<tbody class="affiliateGroup" data-search="${esc(search)}" data-referrals="${row.referral_count}" data-qualified="${row.qualified_count}" data-pending="${row.pending_sort}" data-available="${row.available_sort}" data-lifetime="${row.lifetime_sort}" data-last="${row.last_referral_at?new Date(row.last_referral_at).getTime():0}" data-name="${esc(String(row.display_name||row.email||'').toLowerCase())}"><tr class="affiliateRow"><td><strong>${esc(row.display_name||row.email||'Customer')}</strong><span class="affiliateSub">${esc(row.email||'')}</span></td><td><code>${esc(row.code||'pending')}</code></td><td class="num">${row.referral_count}</td><td class="num">${row.qualified_count}</td><td>${esc(row.pending_text)}</td><td>${esc(row.available_text)}</td><td>${esc(row.lifetime_text)}</td><td>${esc(displayDate(row.last_referral_at))}</td><td><span class="pill ${row.status_tone}">${esc(row.status)}</span></td><td class="affiliateAction"><button type="button" class="button secondary sm affiliateToggle" aria-expanded="false" aria-controls="affiliate-detail-${index}">${row.referral_count?'View':'Manage'}</button></td></tr><tr class="affiliateDetailRow" id="affiliate-detail-${index}" hidden><td colspan="10">${affiliateDetail(req,row,settings)}</td></tr></tbody>`;
  }).join('');
  return `<div class="affiliateTools"><div class="affiliateSearch"><label for="affiliateSearch">Search</label><input class="input" id="affiliateSearch" type="search" placeholder="Username, email or referral code"></div><div class="affiliateFilter"><label for="affiliateFilter">Show</label><select class="input" id="affiliateFilter"><option value="all">All customers</option><option value="referrals">Has referrals</option><option value="pending">Pending credit</option><option value="available">Available credit</option></select></div><div class="affiliateCount"><strong id="affiliateResultCount">${rows.length}</strong><span>customers shown</span></div></div><div class="tableWrap affiliateTableWrap"><table class="dataTable affiliateTable"><thead><tr><th><button type="button" class="affiliateSort" data-sort="name">Affiliate</button></th><th>Code</th><th><button type="button" class="affiliateSort" data-sort="referrals">Referrals</button></th><th><button type="button" class="affiliateSort" data-sort="qualified">Qualified</button></th><th><button type="button" class="affiliateSort" data-sort="pending">Pending credit</button></th><th><button type="button" class="affiliateSort" data-sort="available">Available credit</button></th><th><button type="button" class="affiliateSort" data-sort="lifetime">Lifetime earned</button></th><th><button type="button" class="affiliateSort" data-sort="last">Last referral</button></th><th>Status</th><th></th></tr></thead>${bodies}</table></div>`;
}

function styles(){return `<style>
.affiliateSettings{margin-bottom:12px}.affiliateSettings>summary{display:flex;align-items:center;gap:12px;padding:12px 14px;cursor:pointer;list-style:none}.affiliateSettings>summary::-webkit-details-marker{display:none}.affiliateSettings>summary strong{font-size:.86rem}.affiliateSettings>summary .muted{margin-left:auto}.affiliateSettings>summary:after{content:'▸';color:var(--muted);font-size:.72rem}.affiliateSettings[open]>summary:after{transform:rotate(90deg)}.affiliateSettingsBody{border-top:1px solid var(--border);padding:12px}.affiliateTools{display:grid;grid-template-columns:minmax(260px,1fr) 220px auto;gap:10px;align-items:end;padding:12px;border-bottom:1px solid var(--border)}.affiliateTools label{display:block;font-size:.68rem;color:var(--muted);font-weight:700;margin-bottom:4px}.affiliateCount{display:flex;align-items:baseline;justify-content:flex-end;gap:5px;padding-bottom:7px}.affiliateCount strong{font-size:1rem}.affiliateCount span{font-size:.7rem;color:var(--muted)}.affiliateTableWrap{overflow:auto}.affiliateTable{width:100%;min-width:1120px}.affiliateTable th,.affiliateTable td{vertical-align:middle}.affiliateTable th:nth-child(1){min-width:190px}.affiliateTable th:nth-child(2){min-width:105px}.affiliateTable th:nth-child(5),.affiliateTable th:nth-child(6),.affiliateTable th:nth-child(7){min-width:120px}.affiliateTable th:nth-child(8){min-width:145px}.affiliateTable th:nth-child(9){min-width:115px}.affiliateTable .num{text-align:center}.affiliateSub{display:block;color:var(--muted);font-size:.68rem;margin-top:2px}.affiliateSort{border:0;background:transparent;color:inherit;font:inherit;font-weight:inherit;padding:0;cursor:pointer;text-align:left}.affiliateSort:after{content:' ↕';color:var(--muted);font-size:.65rem}.affiliateSort[data-direction="asc"]:after{content:' ↑'}.affiliateSort[data-direction="desc"]:after{content:' ↓'}.affiliateAction{text-align:right}.affiliateDetailRow td{padding:0!important;background:color-mix(in srgb,var(--h-customers,#40b7df) 2%,transparent)}.affiliateDetailInner{padding:14px 16px 16px}.affiliateDetailHead{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:10px}.affiliateDetailHead>div:first-child{display:grid;gap:2px}.affiliateDetailHead>div:first-child span{font-size:.7rem;color:var(--muted)}.affiliateAdjust{min-width:180px}.affiliateAdjust>summary{cursor:pointer;font-size:.72rem;font-weight:750;list-style:none;text-align:right}.affiliateAdjust>summary::-webkit-details-marker{display:none}.affiliateAdjust[open]{width:min(620px,100%)}.affiliateAdjust .formPanel{margin-top:8px}.referralHistory{display:grid;gap:7px}.referralHistoryItem{border:1px solid var(--border);border-radius:8px;padding:9px 11px;background:rgba(255,255,255,.012)}.referralHistoryMain{display:grid;grid-template-columns:minmax(180px,1fr) auto minmax(120px,auto);align-items:center;gap:12px}.referralHistoryMain>div:first-child span,.referralReward span{display:block;color:var(--muted);font-size:.67rem;margin-top:2px}.referralReward{text-align:right}.referralMeta{font-size:.68rem;color:var(--muted);margin-top:5px}.affiliateTopUp{margin-top:8px}.affiliateEmpty{padding:12px}.affiliateGroup[hidden]{display:none}@media(max-width:900px){.affiliateTools{grid-template-columns:1fr 1fr}.affiliateCount{grid-column:1/-1;justify-content:flex-start}.affiliateDetailHead{flex-direction:column}.affiliateAdjust>summary{text-align:left}.referralHistoryMain{grid-template-columns:1fr auto}.referralReward{grid-column:1/-1;text-align:left}}
</style>`;}

function script(){return `<script src="/js/admin-referrals.js" defer></script>`;}

async function page(req){
  await runtimeSettings.ensureLoaded();
  await affiliateCredits.matureDueCredits();
  const[settings,affiliates,redemptions]=await Promise.all([affiliateCredits.loadSettings(),affiliateRows(),redemptionRows()]);
  const performance=buildPerformanceRows(affiliates,redemptions);
  const balances=affiliates.flatMap(a=>Array.isArray(a.balances)?a.balances:[]),available=currencyTotals(balances,'available_minor'),pending=currencyTotals(balances,'pending_minor');
  const referring=performance.filter(row=>row.referral_count>0).length;
  const settingsPanel=`<details class="section affiliateSettings"><summary><strong>Affiliate programme settings</strong><span class="muted">${settings.enabled?'Enabled':'Disabled'} · ${esc(settings.rewardPercent)}% reward · ${esc(settings.qualificationDelayDays)}d qualification · ${esc(settings.refundWindowDays)}d refund window</span></summary><div class="affiliateSettingsBody"><div class="notice"><strong>Historical rewards are immutable.</strong> Changing the percentage below affects newly created referral rewards. Historical referrals can still be topped up from the affiliate's expanded row when intentionally backfilling them.</div><form class="formPanel" method="post" action="/admin/referrals/settings">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Future referral reward (%)</label><input class="input" type="number" min="1" max="100" name="rewardPercent" value="${esc(settings.rewardPercent)}"><div class="inlineHelp">Percentage of the actual qualifying referred payment converted into same-currency CAPTAiNFiN service credit for newly earned rewards.</div></div><div class="formGroup"><label>Qualification delay (days)</label><input class="input" type="number" min="0" max="90" name="qualificationDelayDays" value="${esc(settings.qualificationDelayDays)}"><div class="inlineHelp">Minimum delay after the qualifying paid purchase before credit may become available.</div></div><div class="formGroup"><label>Refund/dispute window (days)</label><input class="input" type="number" min="0" max="90" name="refundWindowDays" value="${esc(settings.refundWindowDays)}"><div class="inlineHelp">Unused referral credit remains pending through this protection window.</div></div><div class="formGroup"><label class="toggleRow"><input type="checkbox" name="enabled" ${settings.enabled?'checked':''}><span>Affiliate programme enabled</span></label></div></div><button class="button">Save affiliate settings</button></form></div></details>`;
  const body=`${styles()}${notice(req)}
<div class="metrics"><div class="metric"><div class="metricLabel">Referring affiliates</div><div class="metricValue">${referring}</div></div><div class="metric"><div class="metricLabel">Total referrals</div><div class="metricValue">${redemptions.length}</div></div><div class="metric"><div class="metricLabel">Available service credit</div><div class="metricValue smallish">${esc(available)}</div></div><div class="metric"><div class="metricLabel">Pending service credit</div><div class="metricValue smallish">${esc(pending)}</div></div></div>
${settingsPanel}
<section class="section"><div class="sectionHead"><div><h2>Affiliate performance</h2><div class="muted">One customer per row · search, filter and sort · referral history expands in place</div></div><span class="muted">${performance.length} customers</span></div>${affiliateTable(req,performance,settings)}</section>${script()}`;
  return layout({siteName:runtimeSettings.siteName(),active:'referrals',title:'Affiliates',subtitle:'Referral performance, service-credit balances and audited corrections',body,action:'<a class="button secondary" href="/admin/referrals/export">Export CSV</a>'});
}

function createAdminReferralsRouter(){
  const router=express.Router();
  router.use('/admin/referrals',gate,noStore);
  router.get('/admin/referrals',async(req,res,next)=>{try{return res.send(await page(req));}catch(e){next(e);}});
  router.get('/admin/referrals/export',async(_req,res,next)=>{try{const[affiliates,redemptions]=await Promise.all([affiliateRows(),redemptionRows()]);const rows=buildPerformanceRows(affiliates,redemptions).map(row=>({...row,last_referral:displayDate(row.last_referral_at)}));return sendCsv(res,'affiliates.csv',[{key:'display_name',label:'Affiliate'},{key:'email',label:'Email'},{key:'code',label:'Referral code'},{key:'referral_count',label:'Referrals'},{key:'qualified_count',label:'Qualified referrals'},{key:'pending_text',label:'Pending credit'},{key:'available_text',label:'Available credit'},{key:'lifetime_text',label:'Lifetime referral rewards'},{key:'last_referral',label:'Last referral'},{key:'status',label:'Status'}],rows);}catch(e){next(e);}});
  router.post('/admin/referrals/settings',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const rewardPercent=Number.parseInt(req.body.rewardPercent,10),qualificationDelayDays=Number.parseInt(req.body.qualificationDelayDays,10),refundWindowDays=Number.parseInt(req.body.refundWindowDays,10);
      if(!Number.isFinite(rewardPercent)||rewardPercent<1||rewardPercent>100)throw new Error('Enter a reward percentage from 1 to 100.');
      if(!Number.isFinite(qualificationDelayDays)||qualificationDelayDays<0||qualificationDelayDays>90)throw new Error('Enter a qualification delay of 0-90 days.');
      if(!Number.isFinite(refundWindowDays)||refundWindowDays<0||refundWindowDays>90)throw new Error('Enter a refund/dispute window of 0-90 days.');
      const value={enabled:req.body.enabled==='on',rewardPercent,qualificationDelayDays,refundWindowDays};
      await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by) VALUES('affiliate_program',$1::jsonb,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1::jsonb,updated_by=$2,updated_at=NOW()`,[JSON.stringify(value),req.session.authUserId]);
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.affiliates.settings','platform_setting','affiliate_program',$2::jsonb)`,[req.session.authUserId,JSON.stringify(value)]);
      return res.redirect('/admin/referrals?message='+encodeURIComponent('Affiliate settings saved. Historical earned rewards were not changed.'));
    }catch(e){return res.redirect('/admin/referrals?error='+encodeURIComponent(e.message));}
  });
  router.post('/admin/referrals/rewards/:creditId/top-up',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const result=await affiliateCredits.topUpRewardToCurrentRate({creditId:req.params.creditId,actorUserId:req.session.authUserId,reason:req.body.reason});
      const message=result.created?`Added ${money(result.topUpMinor,result.currency)} service credit to bring the historical referral to ${result.targetRewardPercent}%.`:`No top-up was needed; that referral is already at or above the current ${result.targetRewardPercent||''}% rate.`;
      return res.redirect('/admin/referrals?message='+encodeURIComponent(message));
    }catch(e){return res.redirect('/admin/referrals?error='+encodeURIComponent(e.message));}
  });
  router.post('/admin/referrals/:customerId/adjust-credit',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const amountMinor=majorToMinor(req.body.amount);
      const result=await affiliateCredits.adminAdjustCredit({customerId:req.params.customerId,currency:req.body.currency,amountMinor,reason:req.body.reason,actorUserId:req.session.authUserId});
      return res.redirect('/admin/referrals?message='+encodeURIComponent(`Applied ${money(result.amountMinor,result.currency)} affiliate service-credit adjustment.`));
    }catch(e){return res.redirect('/admin/referrals?error='+encodeURIComponent(e.message));}
  });
  return router;
}

module.exports={createAdminReferralsRouter,currencyTotals,majorToMinor,rewardPreview,buildPerformanceRows};