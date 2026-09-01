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
      referrer.display_name referrer_name,referred.display_name referred_name,
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

function adjustmentForm(req,affiliate){return `<details class="affiliateAdjust"><summary>Adjust service credit</summary><form class="formPanel compact" method="post" action="/admin/referrals/${encodeURIComponent(affiliate.id)}/adjust-credit">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Amount</label><input class="input" name="amount" inputmode="decimal" placeholder="10.00 or -5.00" required><div class="inlineHelp">Positive adds immediately spendable credit; negative removes currently spendable credit.</div></div><div class="formGroup"><label>Currency</label><select class="input" name="currency"><option>GBP</option><option>USD</option><option>EUR</option></select></div><div class="formGroup span2"><label>Reason</label><input class="input" name="reason" maxlength="500" placeholder="Why is this correction required?" required></div></div><button class="button secondary" type="submit">Apply credit adjustment</button></form></details>`;}

function referralCard(req,row,settings){
  const preview=rewardPreview(row,settings),reward=row.amount_minor?`<div class="subText">Original reward ${esc(money(row.amount_minor,row.currency))}${Number(row.top_up_minor||0)>0?` · historical top-ups ${esc(money(row.top_up_minor,row.currency))}`:''} · ${esc(row.credit_state||'')}</div>`:'';
  let correction='';
  if(preview){
    correction=`<div class="subText">Qualifying payment ${esc(money(preview.paidMinor,row.currency))} · original rate ${preview.originalPercent?`${esc(preview.originalPercent)}%`:'not recorded'} · current programme rate ${esc(settings.rewardPercent)}% · current-rate target ${esc(money(preview.targetMinor,row.currency))}</div>`;
    if(preview.topUpMinor>0&&row.status==='rewarded'&&row.credit_state!=='void'){
      correction+=`<form class="formPanel compact affiliateTopUp" method="post" action="/admin/referrals/rewards/${encodeURIComponent(row.credit_id)}/top-up">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Historical reward correction</label><div class="inlineHelp">Top up by <strong>${esc(money(preview.topUpMinor,row.currency))}</strong> so this referral reaches the current ${esc(settings.rewardPercent)}% rate. The original reward remains unchanged.</div></div><div class="formGroup"><label>Reason</label><input class="input" name="reason" maxlength="500" value="Backfill referral reward to current ${esc(settings.rewardPercent)}% rate" required></div></div><button class="button secondary" type="submit">Top up to current rate</button></form>`;
    }else if(row.status==='rewarded'&&row.credit_state!=='void')correction+=`<div class="inlineHelp">This referral is already at or above the current ${esc(settings.rewardPercent)}% reward rate.</div>`;
  }
  return `<div class="serverCard"><div class="serverTop"><div><strong>${esc(row.referrer_name||'Affiliate')}</strong><div class="subText">referred ${esc(row.referred_name||'customer')} · ${esc(row.referral_code)}</div></div><span class="pill ${row.status==='rewarded'?'good':row.status==='unfulfilled'||row.status==='reversed'?'warn':'accent'}">${esc(row.status)}</span></div>${reward}${correction}${row.reward_note?`<div class="subText">${esc(row.reward_note)}</div>`:''}</div>`;
}

async function page(req){
  await runtimeSettings.ensureLoaded();
  await affiliateCredits.matureDueCredits();
  const[settings,affiliates,redemptions]=await Promise.all([affiliateCredits.loadSettings(),affiliateRows(),redemptionRows()]);
  const balances=affiliates.flatMap(a=>Array.isArray(a.balances)?a.balances:[]),available=currencyTotals(balances,'available_minor'),pending=currencyTotals(balances,'pending_minor');
  const body=`${notice(req)}
<div class="metrics"><div class="metric"><div class="metricLabel">Affiliates</div><div class="metricValue">${affiliates.length}</div></div><div class="metric"><div class="metricLabel">Referrals</div><div class="metricValue">${redemptions.length}</div></div><div class="metric"><div class="metricLabel">Available service credit</div><div class="metricValue smallish">${esc(available)}</div></div><div class="metric"><div class="metricLabel">Pending service credit</div><div class="metricValue smallish">${esc(pending)}</div></div></div>
<section class="section"><div class="sectionHead"><h2>Affiliate programme</h2><span class="muted">Future reward policy and qualification timing</span></div><div class="notice"><strong>Historical rewards are immutable.</strong> Changing the percentage below affects newly created referral rewards. Use <em>Top up to current rate</em> on a historical referral when you intentionally want to backfill it.</div><form class="formPanel" method="post" action="/admin/referrals/settings">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Future referral reward (%)</label><input class="input" type="number" min="1" max="100" name="rewardPercent" value="${esc(settings.rewardPercent)}"><div class="inlineHelp">Percentage of the actual qualifying referred payment converted into same-currency CAPTAiNFiN service credit for newly earned rewards.</div></div><div class="formGroup"><label>Qualification delay (days)</label><input class="input" type="number" min="0" max="90" name="qualificationDelayDays" value="${esc(settings.qualificationDelayDays)}"><div class="inlineHelp">Minimum delay after the qualifying paid purchase before credit may become available.</div></div><div class="formGroup"><label>Refund/dispute window (days)</label><input class="input" type="number" min="0" max="90" name="refundWindowDays" value="${esc(settings.refundWindowDays)}"><div class="inlineHelp">Unused referral credit remains pending through this protection window.</div></div><div class="formGroup"><label class="toggleRow"><input type="checkbox" name="enabled" ${settings.enabled?'checked':''}><span>Affiliate programme enabled</span></label></div></div><button class="button">Save affiliate settings</button></form></section>
<section class="section"><div class="sectionHead"><h2>Affiliate accounts</h2><span class="muted">${affiliates.length} enrolled · manual corrections are audited</span></div>${affiliates.length?`<div class="serverGrid">${affiliates.map(a=>`<div class="serverCard"><div class="serverTop"><div><strong>${esc(a.display_name||a.email||'Affiliate')}</strong><div class="subText">${esc(a.email||'')} · code ${esc(a.code||'pending')}</div></div><span class="pill ${a.active?'good':'warn'}">${a.active?'Active':'Disabled'}</span></div><div class="subText">${esc(a.balance_summary)}</div>${adjustmentForm(req,a)}</div>`).join('')}</div>`:'<div class="empty">No affiliate accounts yet. A customer becomes an affiliate when they open the affiliate programme or earn their first reward.</div>'}</section>
<section class="section"><div class="sectionHead"><h2>Referral activity</h2><span class="muted">Newest first · original earned rewards are never rewritten</span></div>${redemptions.length?`<div class="serverGrid">${redemptions.map(r=>referralCard(req,r,settings)).join('')}</div>`:'<div class="empty">No referrals yet.</div>'}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'referrals',title:'Affiliates',subtitle:'Referral attribution, service-credit balances, qualification and audited corrections',body,action:'<a class="button secondary" href="/admin/referrals/export">Export CSV</a>'});
}

function createAdminReferralsRouter(){
  const router=express.Router();
  router.use('/admin/referrals',gate,noStore);
  router.get('/admin/referrals',async(req,res,next)=>{try{return res.send(await page(req));}catch(e){next(e);}});
  router.get('/admin/referrals/export',async(_req,res,next)=>{try{return sendCsv(res,'affiliates.csv',[{key:'display_name',label:'Affiliate'},{key:'email',label:'Email'},{key:'code',label:'Referral code'},{key:'active',label:'Active'},{key:'balance_summary',label:'Currency balances'}],await affiliateRows());}catch(e){next(e);}});
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

module.exports={createAdminReferralsRouter,currencyTotals,majorToMinor,rewardPreview};
