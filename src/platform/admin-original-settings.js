'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const providerSettings = require('../payments/provider-settings');
const requestServiceSettings = require('../integrations/request-service-settings');
const emailSettings = require('../integrations/email-settings');
const { layout, esc } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function notice(value, kind = '') { return value ? `<div class="notice ${kind}">${esc(value)}</div>` : ''; }
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function int(value, min, max, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
function cleanSiteName(value) {
    const name = String(value || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('Site name must be between 2 and 80 visible characters.');
    }
    return name;
}
async function load() {
    await Promise.all([
        runtimeSettings.ensureLoaded(), providerSettings.ensureLoaded(), requestServiceSettings.ensureLoaded()
    ]);
    const [rows, plans, stripe, paypal, requests, email, resellerDefaults, automation] = await Promise.all([
        query("SELECT setting_key,setting_value FROM platform_settings WHERE setting_key IN ('storefront','storefront_features','admin_defaults')"),
        query("SELECT code,name FROM plans WHERE active=TRUE AND audience IN ('direct','both') ORDER BY sort_order,price_minor,name"),
        providerSettings.status('stripe'),
        providerSettings.status('paypal'),
        requestServiceSettings.status(),
        emailSettings.status().catch(() => ({ configured: false, enabled: false })),
        query("SELECT setting_value FROM platform_settings WHERE setting_key='reseller_defaults_v2'"),
        query(`SELECT COUNT(*)::int jobs,
                      COUNT(*) FILTER (WHERE enabled=TRUE)::int enabled,
                      COUNT(*) FILTER (WHERE last_error IS NOT NULL)::int errors
               FROM automation_job_state`)
    ]);
    const settings = Object.fromEntries(rows.rows.map(row => [row.setting_key, row.setting_value]));
    const fallbackPlan = plans.rows[0]?.code || '';
    const rd = resellerDefaults.rows[0]?.setting_value || {};
    return {
        store: settings.storefront || {},
        features: Array.isArray(settings.storefront_features) ? settings.storefront_features : [],
        admin: {
            defaultPlanCode: fallbackPlan,
            defaultServerClass: 'premium',
            defaultServerPriority: 100,
            defaultServerMaxUsers: 0,
            expiringWindowDays: 3,
            recentCustomerLimit: 12,
            ...(settings.admin_defaults || {})
        },
        platform: {
            siteName: runtimeSettings.siteName(),
            storefrontEnabled: runtimeSettings.storefrontEnabled(),
            publicRegistration: runtimeSettings.publicRegistrationOpen(),
            requireEmailVerification: runtimeSettings.requireEmailVerification()
        },
        integrations: { stripe, paypal, requests, email },
        resellerDefaults: {
            ledgerCurrency: String(rd.ledgerCurrency || 'GBP').toUpperCase(),
            paymentMethods: Array.isArray(rd.paymentMethods) ? rd.paymentMethods : [],
            ownerAccountAllowed: rd.ownerAccountAllowed !== false,
            defaultTierId: rd.defaultTierId || null
        },
        automation: automation.rows[0] || { jobs: 0, enabled: 0, errors: 0 },
        plans: plans.rows
    };
}
function status(label, value, kind = 'accent', hint = '') {
    return `<div class="compact-item"><div><div class="compact-title">${esc(label)}</div><div class="compact-meta">${esc(hint)}</div></div><span class="pill ${kind}">${esc(value)}</span></div>`;
}
function integrationLabel(item) {
    if (item?.enabled === false) return ['Disabled', 'warn'];
    if (item?.configured) return ['Ready', 'good'];
    return ['Not configured', 'warn'];
}
function page(req, data) {
    const s=data.store,f=data.features,a=data.admin,pf=data.platform;
    const stripeState=integrationLabel(data.integrations.stripe),paypalState=integrationLabel(data.integrations.paypal),requestState=integrationLabel(data.integrations.requests),emailState=integrationLabel(data.integrations.email);
    const planOptions=data.plans.map(plan=>`<option value="${esc(plan.code)}" ${a.defaultPlanCode===plan.code?'selected':''}>${esc(plan.name)} · ${esc(plan.code)}</option>`).join('');
    const reseller=data.resellerDefaults,auto=data.automation;
    const body=`${notice(req.query.message,'success')}${notice(req.query.error,'error')}
    <div class="settings-grid">
      <section class="settings-card"><div class="card-header"><div><h3>Storefront</h3><div class="settings-hint">Public homepage copy and support details. Pricing and reseller tiers remain database-driven.</div></div><a class="button secondary" href="/" target="_blank" rel="noopener">Preview</a></div><div class="card-body"><form method="post" action="/admin/settings/storefront">${csrfInput(req)}<div class="formGroup"><label>Hero title</label><input class="input" name="heroTitle" maxlength="140" value="${esc(s.heroTitle||'')}"></div><div class="formGroup"><label>Hero subtitle</label><textarea class="input" name="heroSubtitle" maxlength="500">${esc(s.heroSubtitle||'')}</textarea></div><div class="formGrid"><div class="formGroup"><label>Features heading</label><input class="input" name="featureTitle" value="${esc(s.featureTitle||'')}"></div><div class="formGroup"><label>Support email</label><input class="input" type="email" name="supportEmail" value="${esc(s.supportEmail||'')}"></div></div><div class="formGroup"><label>Announcement</label><input class="input" name="announcement" maxlength="200" value="${esc(s.announcement||'')}"></div><div class="formGroup"><label>Features · one per line</label><textarea class="input" name="features" rows="7">${esc(f.join('\n'))}</textarea></div><button class="button">Save storefront</button></form></div></section>

      <section class="settings-card"><div class="card-header"><div><h3>Admin defaults</h3><div class="settings-hint">Convenience defaults for manual customer/server workflows. They do not override plan policy.</div></div></div><div class="card-body"><form method="post" action="/admin/settings/admin-defaults">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Default customer plan</label><select class="input" name="defaultPlanCode">${planOptions||'<option value="">No active direct plans</option>'}</select></div><div class="formGroup"><label>Default server class</label><select class="input" name="defaultServerClass">${['premium','free','custom'].map(x=>`<option ${a.defaultServerClass===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="formGroup"><label>Default server priority</label><input class="input" type="number" min="0" max="10000" name="defaultServerPriority" value="${esc(a.defaultServerPriority)}"></div><div class="formGroup"><label>Default max users · 0 = unlimited</label><input class="input" type="number" min="0" max="100000" name="defaultServerMaxUsers" value="${esc(a.defaultServerMaxUsers)}"></div><div class="formGroup"><label>Expiring-soon window · days</label><input class="input" type="number" min="1" max="30" name="expiringWindowDays" value="${esc(a.expiringWindowDays)}"></div><div class="formGroup"><label>Recent customers on dashboard</label><input class="input" type="number" min="5" max="50" name="recentCustomerLimit" value="${esc(a.recentCustomerLimit)}"></div></div><button class="button">Save admin defaults</button></form></div></section>

      <section class="settings-card"><div class="card-header"><div><h3>Reseller model</h3><div class="settings-hint">Monthly parent subscriptions are the primary reseller entitlement. Credits are legacy/history only.</div></div><a class="button secondary" href="/admin/settings/resellers">Configure</a></div><div class="card-body">${status('Default ledger currency',reseller.ledgerCurrency,'accent','Downstream reseller-reported sales')}${status('Default payment methods',reseller.paymentMethods.length?reseller.paymentMethods.join(', '):'None','accent','Selectable when a reseller records a sale')}${status('Owner Jellyfin account',reseller.ownerAccountAllowed?'Allowed':'Disabled',reseller.ownerAccountAllowed?'good':'warn','Counts as one active entitlement when used')}<div class="quick-actions" style="margin-top:12px"><a class="quick-action" href="/admin/reseller-tiers"><strong>Monthly reseller tiers</strong><span>Price, recurring mappings, capacity and downstream-plan matrix</span></a><a class="quick-action" href="/admin/reseller-management"><strong>Reseller management</strong><span>Subscriptions, seats, estate, grace and activation</span></a></div></div></section>

      <section class="settings-card"><div class="card-header"><div><h3>Platform</h3><div class="settings-hint">Site identity and public entry points. Background schedules live in Automation.</div></div></div><div class="card-body"><form method="post" action="/admin/settings/platform">${csrfInput(req)}<div class="formGroup"><label>Site name</label><input class="input" name="siteName" minlength="2" maxlength="80" value="${esc(pf.siteName)}" required></div><div class="toggleGrid"><label class="toggleRow"><input type="checkbox" name="storefrontEnabled" ${pf.storefrontEnabled?'checked':''}><span><strong>Publish public storefront</strong><small class="muted">Clean installs remain private until intentionally published.</small></span></label><label class="toggleRow"><input type="checkbox" name="publicRegistration" ${pf.publicRegistration?'checked':''}><span><strong>Public registration open</strong><small class="muted">Invitations/admin onboarding still work while off.</small></span></label><label class="toggleRow"><input type="checkbox" name="requireEmailVerification" ${pf.requireEmailVerification?'checked':''}><span><strong>Require email verification</strong></span></label></div><button class="button">Save platform settings</button></form><div class="securityNote standalone"><strong>2FA:</strong> when enabled/required it is enforced at staff sign-in. Routine settings forms do not consume a new authenticator/recovery code.</div></div></section>

      <section class="settings-card"><div class="card-header"><div><h3>Automation</h3><div class="settings-hint">One canonical scheduler, executed by the dedicated automation-worker.</div></div><a class="button secondary" href="/admin/automation">Manage jobs</a></div><div class="card-body">${status('Registered jobs',auto.jobs,'accent','All recurring platform work')}${status('Enabled jobs',auto.enabled,Number(auto.enabled)===Number(auto.jobs)?'good':'warn','Schedules are independently selectable')}${status('Jobs with last error',auto.errors,Number(auto.errors)===0?'good':'bad','Open Automation for details and Run now')}</div></section>

      <section class="settings-card"><div class="card-header"><div><h3>Integrations</h3><div class="settings-hint">Status is read from the same canonical services used by runtime behavior.</div></div></div><div class="card-body">${status('Stripe',stripeState[0],stripeState[1],'Commerce → Payments')}${status('PayPal',paypalState[0],paypalState[1],'Commerce → Payments')}${status('Request service',requestState[0],requestState[1],data.integrations.requests.baseUrl||'Request user synchronization')}${status('Transactional email',emailState[0],emailState[1],'Browser-managed SMTP / encrypted credentials')}${status('Telegram',process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID?'Server configured':'Not configured',process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID?'good':'warn','Implemented notification channel; credentials remain infrastructure secrets')}${status('Activity mode',String(process.env.STREAM_POLICY_MODE||'observe').toUpperCase(),'accent','Playback-policy worker mode')}<div class="quick-actions" style="margin-top:12px"><a class="quick-action" href="/admin/payments"><strong>Payment gateways</strong><span>Stripe / PayPal credentials, enable switches and tests</span></a><a class="quick-action" href="/admin/email"><strong>Email</strong><span>SMTP settings, connection test and delivery queue</span></a><a class="quick-action" href="/admin/request-users"><strong>Request service</strong><span>URL, API key, sync and plan quotas</span></a><a class="quick-action" href="/admin/notifications"><strong>Notifications</strong><span>Email / Telegram event preferences</span></a><a class="quick-action" href="/admin/setup"><strong>Setup readiness</strong><span>Direct commerce, reseller commerce and integrations</span></a></div></div></section>
    </div>`;
    return layout({siteName:runtimeSettings.siteName(),active:'settings',title:'Settings',subtitle:'Public identity, defaults and canonical integration state',body});
}
async function saveSetting(key,value,req,{merge=false}={}) {
    const conflict=merge?'setting_value=platform_settings.setting_value || EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()':'setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()';
    await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at) VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(setting_key) DO UPDATE SET ${conflict}`,[key,JSON.stringify(value),req.session.authUserId]);
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.settings.update',$2,$2,$3::jsonb)`,[req.session.authUserId,key,JSON.stringify(value)]);
}
function createAdminOriginalSettingsRouter() {
    const router=express.Router();router.use('/admin/settings',gate);
    router.get('/admin/settings',async(req,res,next)=>{try{res.setHeader('Cache-Control','no-store, private, max-age=0');return res.send(page(req,await load()));}catch(error){return next(error);}});
    router.post('/admin/settings/admin-defaults',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const requested=String(req.body.defaultPlanCode||''),available=await query("SELECT code FROM plans WHERE active=TRUE AND audience IN ('direct','both') ORDER BY CASE WHEN code=$1 THEN 0 ELSE 1 END,sort_order,price_minor,name LIMIT 1",[requested]),serverClass=['premium','free','custom'].includes(req.body.defaultServerClass)?req.body.defaultServerClass:'premium';await saveSetting('admin_defaults',{defaultPlanCode:available.rows[0]?.code||'',defaultServerClass:serverClass,defaultServerPriority:int(req.body.defaultServerPriority,0,10000,100),defaultServerMaxUsers:int(req.body.defaultServerMaxUsers,0,100000,0),expiringWindowDays:int(req.body.expiringWindowDays,1,30,3),recentCustomerLimit:int(req.body.recentCustomerLimit,5,50,12)},req);return res.redirect('/admin/settings?message='+encodeURIComponent('Admin defaults saved.'));}catch(error){return res.redirect('/admin/settings?error='+encodeURIComponent(error.message||'Admin defaults could not be saved safely.'));}});
    router.post('/admin/settings/platform',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await saveSetting('platform',{siteName:cleanSiteName(req.body.siteName),storefrontEnabled:req.body.storefrontEnabled==='on',publicRegistration:req.body.publicRegistration==='on',requireEmailVerification:req.body.requireEmailVerification==='on'},req,{merge:true});await runtimeSettings.reload();return res.redirect('/admin/settings?message='+encodeURIComponent('Platform settings saved.'));}catch(error){return res.redirect('/admin/settings?error='+encodeURIComponent(error.message));}});
    return router;
}
module.exports={createAdminOriginalSettingsRouter,load,page};
