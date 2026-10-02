'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const runtimeSettings=require('./runtime-settings');
const provisioning=require('../jellyfin/resilient-provisioning');
const adminProfileSecurity=require('../security/admin-profile-account');
const adminPersonalProfile=require('../customers/admin-personal-media-profile');
const {page:emailInfrastructurePage}=require('./admin-email');
const {layout,esc}=require('./admin-html');

function gate(req,res,next){
  if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();
  return res.redirect('/login?session=expired');
}
function noStore(_req,res,next){
  res.setHeader('Cache-Control','no-store, private, max-age=0');
  res.setHeader('Pragma','no-cache');
  next();
}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`;}
function cleanEmail(value){
  const email=String(value||'').trim().toLowerCase();
  if(email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw new Error('Enter a valid email address.');
  return email;
}
function dt(value){return value?new Date(value).toLocaleString('en-GB'):'—';}

async function profileData(userId){
  const [user,customer,plans,accounts]=await Promise.all([
    query(`SELECT id,username,email FROM app_users WHERE id=$1 AND role='admin'`,[userId]),
    query(`SELECT c.id,c.display_name,c.email,
      (SELECT s.status FROM subscriptions s WHERE s.customer_id=c.id ORDER BY (s.status IN ('active','trialing')) DESC,s.created_at DESC LIMIT 1) subscription_status,
      (SELECT s.current_period_end FROM subscriptions s WHERE s.customer_id=c.id ORDER BY (s.status IN ('active','trialing')) DESC,s.created_at DESC LIMIT 1) current_period_end,
      (SELECT p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=c.id ORDER BY (s.status IN ('active','trialing')) DESC,s.created_at DESC LIMIT 1) plan_name,
      (SELECT COUNT(*)::int FROM jellyfin_accounts ja WHERE ja.customer_id=c.id) account_count,
      (SELECT string_agg(DISTINCT js.name,', ' ORDER BY js.name) FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=c.id) server_names
     FROM customers c WHERE c.user_id=$1 ORDER BY c.created_at LIMIT 1`,[userId]),
    query(`SELECT code,name,billing_interval,duration_days,server_class,streams FROM plans
      WHERE active=TRUE AND archived_at IS NULL
        AND (effective_from IS NULL OR effective_from<=NOW())
        AND (effective_until IS NULL OR effective_until>NOW())
        AND audience IN ('direct','both')
        AND COALESCE(service_type,'jellyfin') IN ('jellyfin','bundle')
      ORDER BY sort_order,name`),
    query(`SELECT ja.id,ja.jellyfin_username,ja.disabled,ja.password_setup_required,ja.is_primary,js.name server_name
      FROM jellyfin_accounts ja
      JOIN jellyfin_servers js ON js.id=ja.server_id
      JOIN customers c ON c.id=ja.customer_id
      WHERE c.user_id=$1
      ORDER BY ja.is_primary DESC,ja.disabled ASC,ja.created_at`,[userId])
  ]);
  return {user:user.rows[0]||{},customer:customer.rows[0]||null,plans:plans.rows,accounts:accounts.rows};
}

function jellyfinPasswordForms(req,accounts){
  if(!accounts.length)return '<div class="muted" style="margin-top:12px">No Jellyfin account has been provisioned yet.</div>';
  return `<div style="margin-top:18px"><h3>Jellyfin sign-in</h3><div class="muted">Set the password for your own linked Jellyfin account here. CAPTAiNFiN never displays or stores the plaintext password.</div>${accounts.map(a=>`<form class="formPanel" method="post" action="/admin/profile/media/jellyfin/${encodeURIComponent(a.id)}/password" style="margin-top:10px">${token(req)}<div class="sectionHead"><div><strong>${esc(a.jellyfin_username)}</strong><div class="muted">${esc(a.server_name)} · ${a.disabled?'disabled':'enabled'}${a.is_primary?' · primary':''}</div></div>${a.password_setup_required?'<span class="pill warn">Password setup required</span>':'<span class="pill good">Password set</span>'}</div><div class="formGrid"><div class="formGroup"><label>New Jellyfin password</label><input class="input" type="password" name="password" minlength="8" maxlength="200" autocomplete="new-password" required></div><div class="formGroup"><label>Confirm password</label><input class="input" type="password" name="confirmPassword" minlength="8" maxlength="200" autocomplete="new-password" required></div></div><button class="button">${a.password_setup_required?'Set Jellyfin password':'Change Jellyfin password'}</button></form>`).join('')}</div>`;
}

async function page(req){
  await runtimeSettings.ensureLoaded();
  const d=await profileData(req.session.authUserId);
  const media=d.customer
    ? `<div class="formPanel"><div class="formGrid"><div><div class="muted">Linked customer profile</div><strong>${esc(d.customer.display_name||d.user.username)}</strong></div><div><div class="muted">Plan</div><strong>${esc(d.customer.plan_name||'No active plan')}</strong></div><div><div class="muted">Subscription</div><strong>${esc(d.customer.subscription_status||'none')}</strong></div><div><div class="muted">Access until</div><strong>${esc(dt(d.customer.current_period_end))}</strong></div><div><div class="muted">Jellyfin accounts</div><strong>${Number(d.customer.account_count||0)}</strong></div><div><div class="muted">Servers</div><strong>${esc(d.customer.server_names||'Not provisioned yet')}</strong></div></div><div class="buttonRow" style="margin-top:14px"><a class="button secondary" href="/admin/users/${encodeURIComponent(d.customer.id)}?tab=access">Open customer access details</a><form method="post" action="/admin/profile/media/reconcile" style="margin:0">${token(req)}<button class="button secondary">Reconcile Jellyfin access</button></form></div>${jellyfinPasswordForms(req,d.accounts)}</div>`
    : `<form class="formPanel" method="post" action="/admin/profile/media">${token(req)}<div class="formGrid"><div class="formGroup"><label>Display name</label><input class="input" name="displayName" maxlength="100" value="${esc(d.user.username||'')}"></div><div class="formGroup"><label>Personal access plan</label><select class="input" name="planCode" required>${d.plans.map(p=>`<option value="${esc(p.code)}">${esc(p.name)} · ${esc(p.server_class)} · ${Number(p.streams||1)} stream${Number(p.streams||1)===1?'':'s'}</option>`).join('')}</select><div class="fieldHelp">This is an administrator grant using the normal plan duration, placement and Jellyfin policy. It does not create a payment.</div></div></div><div class="securityNote standalone">Your administrator role and administrator login stay unchanged. CAPTAiNFiN creates a linked customer/media profile only for entitlement and Jellyfin provisioning. Customer-portal authentication is not enabled for this admin identity.</div><button class="button" ${d.user.email&&d.plans.length?'':'disabled'}>Create my media profile &amp; provision</button>${!d.user.email?'<div class="muted">Set your email above before creating the media profile.</div>':''}${!d.plans.length?'<div class="muted">No active Jellyfin-capable direct plan is available.</div>':''}</form>`;

  const body=`${notice(req)}
    <section class="section"><div class="sectionHead"><div><h2>Account</h2><div class="muted">Personal administrator contact details. Currency is controlled once for the whole portal under Settings → Portal currency.</div></div><span class="pill accent">Administrator</span></div>
      <div class="formGrid">
        <form class="formPanel" method="post" action="/admin/profile/email">${token(req)}<h3>Email</h3><div class="muted">Used as your destination when you enable Email for an administrator notification event.</div><input class="input" type="email" name="email" maxlength="254" required value="${esc(d.user.email||'')}" placeholder="you@example.com"><button class="button">Save email</button></form>
      </div>
    </section>
    <section class="section"><div class="sectionHead"><div><h2>Personal media profile</h2><div class="muted">Optionally make this administrator a normal managed Jellyfin customer as well.</div></div></div>${media}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'my-profile',title:'My profile',subtitle:'Administrator email and personal media access',body});
}

async function saveEmail(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid security token');
  try{
    const email=cleanEmail(req.body.email);
    await adminProfileSecurity.updateAdminEmail({userId:req.session.authUserId,email});
    return res.redirect('/admin/profile?message='+encodeURIComponent('Administrator email saved.'));
  }catch(error){return res.redirect('/admin/profile?error='+encodeURIComponent(error.message||'Email could not be saved.'));}
}

async function createMediaProfile(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid security token');
  let created=null;
  try{
    created=await adminPersonalProfile.createPersonalMediaProfile({
      userId:req.session.authUserId,
      displayName:req.body.displayName,
      planCode:req.body.planCode
    });
    if(created.existing)return res.redirect('/admin/profile?message='+encodeURIComponent('This administrator already has a linked media profile.'));
    try{
      await provisioning.reconcileCustomer(created.customerId);
      return res.redirect('/admin/profile?message='+encodeURIComponent('Personal media profile created and Jellyfin access reconciled. Set your Jellyfin password below.'));
    }catch(error){
      console.error('Admin personal media provisioning failed:',error.message);
      return res.redirect('/admin/profile?error='+encodeURIComponent('Media profile was created, but Jellyfin provisioning needs attention. Check server health and use Reconcile Jellyfin access.'));
    }
  }catch(error){return res.redirect('/admin/profile?error='+encodeURIComponent(error.message||'Personal media profile could not be created.'));}
}

async function reconcileMedia(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid security token');
  try{
    const found=await query(`SELECT id FROM customers WHERE user_id=$1 ORDER BY created_at LIMIT 1`,[req.session.authUserId]);
    if(!found.rowCount)throw new Error('Create your personal media profile first.');
    await provisioning.reconcileCustomer(found.rows[0].id);
    return res.redirect('/admin/profile?message='+encodeURIComponent('Jellyfin access reconciled.'));
  }catch(error){return res.redirect('/admin/profile?error='+encodeURIComponent(error.message||'Jellyfin access could not be reconciled.'));}
}

async function setPersonalJellyfinPassword(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid security token');
  try{
    const password=String(req.body.password||''),confirm=String(req.body.confirmPassword||'');
    if(password!==confirm)throw new Error('Jellyfin passwords do not match.');
    if(password.length<8||password.length>200)throw new Error('Jellyfin password must be between 8 and 200 characters.');
    const owned=await query(`SELECT c.id customer_id,ja.jellyfin_username
      FROM customers c
      JOIN jellyfin_accounts ja ON ja.customer_id=c.id
      WHERE c.user_id=$1 AND ja.id=$2
      LIMIT 1`,[req.session.authUserId,req.params.accountId]);
    if(!owned.rowCount)throw new Error('That Jellyfin account is not part of your personal media profile.');
    const row=owned.rows[0];
    await provisioning.setJellyfinPassword(row.customer_id,req.params.accountId,password);
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.profile.media.password.update','jellyfin_account',$2,$3::jsonb)`,[req.session.authUserId,req.params.accountId,JSON.stringify({customerId:row.customer_id})]);
    return res.redirect('/admin/profile?message='+encodeURIComponent(`Jellyfin password updated for ${row.jellyfin_username}.`));
  }catch(error){return res.redirect('/admin/profile?error='+encodeURIComponent(error.message||'Jellyfin password could not be updated.'));}
}

function createAdminProfileAccountRouter(){
  const r=express.Router();
  r.get('/admin/email',gate,noStore,(_req,res)=>res.redirect(302,'/admin/notifications/email'));
  r.get('/admin/notifications/email',gate,noStore,async(req,res,next)=>{try{return res.send(await emailInfrastructurePage(req));}catch(error){return next(error);}});
  r.use('/admin/profile',gate,noStore);
  r.get('/admin/profile',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){return next(error);}});
  r.post('/admin/profile/email',saveEmail);
  r.post('/admin/profile/media',createMediaProfile);
  r.post('/admin/profile/media/reconcile',reconcileMedia);
  r.post('/admin/profile/media/jellyfin/:accountId/password',setPersonalJellyfinPassword);
  return r;
}

module.exports={createAdminProfileAccountRouter,page,profileData,cleanEmail,setPersonalJellyfinPassword,jellyfinPasswordForms};
