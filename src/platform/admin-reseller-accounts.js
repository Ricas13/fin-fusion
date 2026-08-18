'use strict';

const express=require('express');
const bcrypt=require('bcryptjs');
const {query,transaction}=require('../db');
const auth=require('../auth/service');
const csrf=require('../auth/csrf');
const monthly=require('../resellers/monthly');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'?next():res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function cleanUsername(value){const username=String(value||'').trim();if(!/^[A-Za-z0-9._-]{3,40}$/.test(username))throw new Error('Username must be 3–40 characters using letters, numbers, dot, underscore or dash.');return username}
function cleanEmail(value){const email=String(value||'').trim().toLowerCase();if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Enter a valid email address.');return email||null}
async function createResellerAccount({username,email,password,tierId,months=1,actorUserId}){
  username=cleanUsername(username);email=cleanEmail(email);auth.validateNewPassword(password);
  const tier=await monthly.tierById(tierId);if(!tier||!tier.active)throw new Error('Choose an active reseller plan.');
  const count=Number.parseInt(months,10);if(!Number.isInteger(count)||count<1||count>36)throw new Error('Initial access must be between 1 and 36 months.');
  const hash=await bcrypt.hash(password,12);
  let created;
  try{
    created=await transaction(async client=>{
      const duplicate=await client.query(`SELECT id FROM app_users WHERE lower(username)=lower($1) OR ($2::text IS NOT NULL AND lower(COALESCE(email,''))=lower($2)) LIMIT 1`,[username,email]);
      if(duplicate.rowCount)throw new Error('That username or email already exists.');
      const user=(await client.query(`INSERT INTO app_users(username,email,password_hash,role,active,password_changed_at) VALUES($1,$2,$3,'reseller',TRUE,NOW()) RETURNING id,username,email`,[username,email,hash])).rows[0];
      const reseller=(await client.query(`INSERT INTO resellers(user_id,credits,trial_credits,note) VALUES($1,0,0,'Monthly managed-user reseller') RETURNING id,user_id`,[user.id])).rows[0];
      await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.reseller.account.create','reseller',$2,$3::jsonb)`,[actorUserId,reseller.id,JSON.stringify({username,email,tierId,creditModel:false})]);
      return{user,reseller};
    });
    const subscription=await monthly.createManualTierSubscription({resellerId:created.reseller.id,tierId,months:count,actorUserId});
    return{...created,tier,subscription};
  }catch(error){
    if(created?.user?.id)await query('DELETE FROM app_users WHERE id=$1 AND role=\'reseller\'',[created.user.id]).catch(()=>{});
    throw error;
  }
}
async function listAccounts(){const result=await query(`SELECT r.id,u.username,u.email,u.active,rs.status,rs.current_period_end,rt.name tier_name,rt.seat_limit,(SELECT COUNT(*)::int FROM customers c WHERE c.reseller_id=r.id AND c.reseller_managed=TRUE) managed_users FROM resellers r JOIN app_users u ON u.id=r.user_id LEFT JOIN LATERAL(SELECT * FROM reseller_subscriptions x WHERE x.reseller_id=r.id ORDER BY CASE WHEN x.status='active' AND x.current_period_end>NOW() THEN 0 ELSE 1 END,x.current_period_end DESC LIMIT 1) rs ON TRUE LEFT JOIN reseller_tiers rt ON rt.id=rs.tier_id ORDER BY u.username`);return result.rows}
function accountRow(row){return `<tr><td><strong>${esc(row.username)}</strong><div class="subText">${esc(row.email||'No email')}</div></td><td>${esc(row.tier_name||'No plan')}<div class="subText">${row.seat_limit==null?'—':`${esc(row.managed_users)} / ${esc(row.seat_limit)} managed users`}</div></td><td><span class="pill ${row.status==='active'?'good':'warn'}">${esc(row.status||'No subscription')}</span><div class="subText">${row.current_period_end?`Paid through ${esc(new Date(row.current_period_end).toLocaleDateString('en-GB'))}`:'No paid-through date'}</div></td><td><span class="pill ${row.active?'good':'bad'}">${row.active?'Login active':'Login disabled'}</span></td></tr>`}
async function page(req){await runtimeSettings.ensureLoaded();const[tiers,accounts]=await Promise.all([monthly.listTiers({activeOnly:true}),listAccounts()]),token=csrf.token(req),notice=`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`,form=`<section class="section"><div class="sectionHead"><div><h2>Create reseller login</h2><div class="muted">A reseller pays monthly for a fixed number of managed Jellyfin users. Credits and downstream customer billing are not part of this account.</div></div></div><form method="post" action="/admin/plans/resellers" class="formGrid"><input type="hidden" name="_csrf" value="${esc(token)}"><label>Username<input class="input" name="username" minlength="3" maxlength="40" required autocomplete="off"></label><label>Email<input class="input" type="email" name="email" autocomplete="email"></label><label>Initial password<input class="input" type="password" name="password" minlength="12" maxlength="200" required autocomplete="new-password"><div class="fieldHelp">At least 12 characters. The reseller can enable optional 2FA after sign-in.</div></label><label>Reseller plan<select class="input" name="tierId" required><option value="">Choose plan…</option>${tiers.map(t=>`<option value="${esc(t.id)}">${esc(t.name)} · ${esc(t.seat_limit)} users · ${esc(t.currency)} ${(Number(t.monthly_price_minor||0)/100).toFixed(2)}/month</option>`).join('')}</select></label><label>Initial paid months<input class="input" type="number" name="months" value="1" min="1" max="36" required><div class="fieldHelp">Creates the initial manual entitlement. Future renewals can use configured Stripe/PayPal recurring billing.</div></label><div class="formActions"><button class="button" type="submit">Create reseller account</button></div></form></section>`,list=`<section class="section"><div class="sectionHead"><div><h2>Reseller accounts</h2><div class="muted">${accounts.length} reseller login${accounts.length===1?'':'s'} · monthly seat plans only</div></div></div>${accounts.length?`<div class="tableWrap"><table class="dataTable"><thead><tr><th>Account</th><th>Plan / usage</th><th>Subscription</th><th>Login</th></tr></thead><tbody>${accounts.map(accountRow).join('')}</tbody></table></div>`:'<div class="empty">No reseller accounts yet.</div>'}</section>`;return layout({siteName:runtimeSettings.siteName(),active:'plans',title:'Reseller accounts',subtitle:'Create reseller logins and assign their monthly managed-user plan',body:notice+form+list,action:'<a class="button secondary" href="/admin/plans">Back to Plans</a>'})}
function createAdminResellerAccountsRouter(){const r=express.Router();r.use('/admin/plans/resellers',gate,noStore);r.get('/admin/plans/resellers',async(req,res,next)=>{try{return res.send(await page(req))}catch(error){return next(error)}});r.post('/admin/plans/resellers',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const result=await createResellerAccount({username:req.body.username,email:req.body.email,password:req.body.password,tierId:req.body.tierId,months:req.body.months,actorUserId:req.session.authUserId});return res.redirect('/admin/plans/resellers?message='+encodeURIComponent(`${result.user.username} created on ${result.tier.name}.`))}catch(error){return res.redirect('/admin/plans/resellers?error='+encodeURIComponent(error.message))}});return r}
module.exports={createAdminResellerAccountsRouter,createResellerAccount,listAccounts,page,cleanUsername,cleanEmail};
