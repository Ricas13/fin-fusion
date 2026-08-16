'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const providerSettings = require('../payments/provider-settings');
const requestServiceSettings = require('../integrations/request-service-settings');
const emailSettings = require('../integrations/email-settings');
const protection = require('../security/public-abuse-protection');
const pendingRegistrations = require('../security/pending-registration');
const supportPolicy = require('./support-policy');
const { layout, esc } = require('./admin-html');

const SECTIONS=new Set(['general','commerce','integrations','security','advanced']);
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
function registrationLabel(platform){if(!platform.publicRegistration)return'Invite only';return platform.requireEmailVerification?'Public · verified email':'Public · unverified email';}
async function load() {
    await Promise.all([
        runtimeSettings.ensureLoaded(), providerSettings.ensureLoaded(), requestServiceSettings.ensureLoaded()
    ]);
    const [rows, plans, stripe, paypal, requests, email, resellerDefaults, automation, abuse, pending, support] = await Promise.all([
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
               FROM automation_job_state`),
        protection.get().catch(()=>({enabled:false,siteKey:'',secretConfigured:false,protectRegistration:true,protectPasswordReset:true})),
        pendingRegistrations.stats().catch(()=>({pending:0,expired:0})),
        supportPolicy.get().catch(()=>({docsUrl:'',supportUrl:'',supportEmail:''}))
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
        abuse,
        pending,
        support,
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
function generalSection(req,data){const a=data.admin,pf=data.platform,planOptions=data.plans.map(plan=>`<option value="${esc(plan.code)}" ${a.defaultPlanCode===plan.code?'selected':''}>${esc(plan.name)} · ${esc(plan.code)}</option>`).join('');return `
<section class="settings-card"><div class="card-header"><div><h3>Platform identity</h3><div class="settings-hint">The public name and storefront switch. Registration and anti-abuse controls live under Security.</div></div><a class="button secondary" href="/" target="_blank" rel="noopener">Preview storefront</a></div><div class="card-body"><form method="post" action="/admin/settings/platform">${csrfInput(req)}<div class="formGroup"><label>Site name</label><input class="input" name="siteName" minlength="2" maxlength="80" value="${esc(pf.siteName)}" required></div><label class="toggleRow"><input type="checkbox" name="storefrontEnabled" ${pf.storefrontEnabled?'checked':''}><span><strong>Publish public storefront</strong><small class="muted">Clean installs remain private until intentionally published.</small></span></label><button class="button">Save general settings</button></form></div></section>
<section class="settings-card"><div class="card-header"><div><h3>Admin defaults</h3><div class="settings-hint">Convenience defaults for manual customer/server workflows. They never override a plan policy.</div></div></div><div class="card-body"><form method="post" action="/admin/settings/admin-defaults">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Default customer plan</label><select class="input" name="defaultPlanCode">${planOptions||'<option value="">No active direct plans</option>'}</select></div><div class="formGroup"><label>Default server class</label><select class="input" name="defaultServerClass">${['premium','free','custom'].map(x=>`<option ${a.defaultServerClass===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="formGroup"><label>Default server priority</label><input class="input" type="number" min="0" max="10000" name="defaultServerPriority" value="${esc(a.defaultServerPriority)}"></div><div class="formGroup"><label>Default max users · 0 = unlimited</label><input class="input" type="number" min="0" max="100000" name="defaultServerMaxUsers" value="${esc(a.defaultServerMaxUsers)}"></div><div class="formGroup"><label>Expiring-soon window · days</label><input class="input" type="number" min="1" max="30" name="expiringWindowDays" value="${esc(a.expiringWindowDays)}"></div><div class="formGroup"><label>Recent customers on dashboard</label><input class="input" type="number" min="5" max="50" name="recentCustomerLimit" value="${esc(a.recentCustomerLimit)}"></div></div><button class="button">Save admin defaults</button></form></div></section>
<section class="settings-card"><div class="card-header"><div><h3>Guides, support & setup</h3><div class="settings-hint">Keep customer-facing documentation and operator readiness discoverable instead of relying on an unset environment variable.</div></div></div><div class="card-body">${status('Documentation',data.support.docsUrl?'Published':'Not published',data.support.docsUrl?'good':'warn',data.support.docsUrl||'Add the GitBook/documentation URL under Support & Legal')}<div class="quick-actions" style="margin-top:12px"><a class="quick-action" href="/admin/setup"><strong>Setup readiness</strong><span>Deployment, commerce and integration readiness</span></a><a class="quick-action" href="/admin/settings/support"><strong>Support & Legal</strong><span>Documentation, support, status and policy URLs</span></a></div></div></section>`;}
function commerceSection(_req,data){const reseller=data.resellerDefaults;return `<section class="settings-card"><div class="card-header"><div><h3>Commercial model</h3><div class="settings-hint">Plans, provider mappings and reseller capacity are separate commercial contracts but share the same lifecycle controls.</div></div></div><div class="card-body">${status('Default ledger currency',reseller.ledgerCurrency,'accent','Downstream reseller-reported sales')}${status('Default payment methods',reseller.paymentMethods.length?reseller.paymentMethods.join(', '):'None','accent','Selectable when a reseller records a sale')}${status('Owner Jellyfin account',reseller.ownerAccountAllowed?'Allowed':'Disabled',reseller.ownerAccountAllowed?'good':'warn','Counts as one active entitlement when used')}<div class="quick-actions" style="margin-top:12px"><a class="quick-action" href="/admin/plans"><strong>Plans</strong><span>Direct Jellyfin and service-aware product catalogue</span></a><a class="quick-action" href="/admin/payments"><strong>Payment gateways</strong><span>Stripe and PayPal credentials and mappings</span></a><a class="quick-action" href="/admin/settings/resellers"><strong>Reseller defaults</strong><span>Ledger currency, payment labels and owner-account policy</span></a><a class="quick-action" href="/admin/reseller-tiers"><strong>Reseller plans</strong><span>Monthly price, capacity and downstream plan matrix</span></a><a class="quick-action" href="/admin/discounts"><strong>Discounts</strong><span>Codes, limits and eligibility</span></a><a class="quick-action" href="/admin/referrals"><strong>Referrals</strong><span>Qualification window and reward policy</span></a></div></div></section>`;}
function integrationsSection(_req,data){const stripeState=integrationLabel(data.integrations.stripe),paypalState=integrationLabel(data.integrations.paypal),requestState=integrationLabel(data.integrations.requests),emailState=integrationLabel(data.integrations.email);return `<section class="settings-card"><div class="card-header"><div><h3>Integrations</h3><div class="settings-hint">Status comes from the same canonical services used by runtime behavior.</div></div></div><div class="card-body">${status('Stripe',stripeState[0],stripeState[1],'Commerce → Payments')}${status('PayPal',paypalState[0],paypalState[1],'Commerce → Payments')}${status('Request service',requestState[0],requestState[1],data.integrations.requests.baseUrl||'Request user synchronization')}${status('Transactional email',emailState[0],emailState[1],'SMTP credentials are encrypted at rest')}${status('Telegram',process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID?'Server configured':'Not configured',process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID?'good':'warn','Infrastructure-managed notification credentials')}<div class="quick-actions" style="margin-top:12px"><a class="quick-action" href="/admin/settings/stremio"><strong>Stremio</strong><span>Service foundation, addon credentials and runtime readiness</span></a><a class="quick-action" href="/admin/email"><strong>Email</strong><span>SMTP settings, connection test and delivery queue</span></a><a class="quick-action" href="/admin/request-users"><strong>Request service</strong><span>URL, API key, sync and plan quotas</span></a><a class="quick-action" href="/admin/notifications"><strong>Notifications</strong><span>Email / Telegram event preferences</span></a></div></div></section>`;}
function securitySection(req,data){const pf=data.platform,abuse=data.abuse,pending=data.pending,registration=registrationLabel(pf),emailReady=Boolean(data.integrations.email?.configured);return `<section class="settings-card"><div class="card-header"><div><h3>Registration & verification</h3><div class="settings-hint">Verified public registrations stay in the pending table and do not become customers until the email link is opened.</div></div><span class="pill ${pf.publicRegistration?(pf.requireEmailVerification?'good':'warn'):'accent'}">${esc(registration)}</span></div><div class="card-body"><form method="post" action="/admin/settings/registration">${csrfInput(req)}<div class="formGroup"><label>Registration access</label><select class="input" name="registrationAccess"><option value="invite" ${pf.publicRegistration?'':'selected'}>Invite only</option><option value="public" ${pf.publicRegistration?'selected':''}>Public registration</option></select></div><label class="toggleRow"><input type="checkbox" name="requireEmailVerification" ${pf.requireEmailVerification?'checked':''}><span><strong>Require verified email before creating a public customer</strong><small class="muted">When public registration is open, this uses staged pending registrations. Transactional email must be configured first.</small></span></label><button class="button">Save registration policy</button></form>${status('Transactional email',emailReady?'Ready':'Not configured',emailReady?'good':'warn','Required before Public + verified email can be enabled')}${status('Pending registrations',pending.pending||0,Number(pending.pending||0)?'accent':'good','Temporary staged identities awaiting email verification')}${status('Expired pending rows',pending.expired||0,Number(pending.expired||0)?'warn':'good','Removed automatically by pending_registration_cleanup')}${status('Turnstile',abuse.enabled?'Enabled':'Optional / off',abuse.enabled?'good':'accent',abuse.enabled?(abuse.protectRegistration?'Registration protected':'Enabled but registration not selected'):'Rate limiting remains active even when Turnstile is off')}<div class="quick-actions" style="margin-top:12px"><a class="quick-action" href="/admin/settings/abuse-protection"><strong>Abuse protection</strong><span>Turnstile site/secret and protected forms</span></a><a class="quick-action" href="/admin/security"><strong>Administrator security</strong><span>2FA, password, recovery codes and sessions</span></a></div></div></section>`;}
function advancedSection(_req,data){const auto=data.automation;return `<section class="settings-card"><div class="card-header"><div><h3>Advanced operations</h3><div class="settings-hint">Low-frequency controls that can materially change platform state are kept away from everyday settings.</div></div></div><div class="card-body">${status('Registered automation jobs',auto.jobs,'accent','Includes cleanup, billing, entitlement and reconciliation work')}${status('Enabled jobs',auto.enabled,Number(auto.enabled)===Number(auto.jobs)?'good':'warn','Schedules are independently selectable')}${status('Jobs with last error',auto.errors,Number(auto.errors)===0?'good':'bad','Open Automation for details')}<div class="quick-actions" style="margin-top:12px"><a class="quick-action" href="/admin/automation"><strong>Automation jobs</strong><span>Schedules, health and Run now</span></a><a class="quick-action" href="/admin/provisioning/drift"><strong>Policy Drift</strong><span>Detect hand-edits made directly in Jellyfin</span></a><a class="quick-action" href="/admin/configuration"><strong>Configuration Transfer</strong><span>Reviewed export/apply workflow</span></a></div></div></section>`;}
function page(req, data) {
    const section=SECTIONS.has(String(req.query.section||''))?String(req.query.section):'general';
    const render={general:generalSection,commerce:commerceSection,integrations:integrationsSection,security:securitySection,advanced:advancedSection}[section];
    const titles={general:['Settings · General','Identity, defaults, documentation and setup entry points'],commerce:['Settings · Commerce','Commercial catalogue, provider and reseller controls'],integrations:['Settings · Integrations','External services and delivery channels'],security:['Settings · Security','Registration, verification and abuse-protection controls'],advanced:['Settings · Advanced','Low-frequency automation, drift and configuration-transfer controls']};
    const body=`${notice(req.query.message,'success')}${notice(req.query.error,'error')}<div class="settings-grid">${render(req,data)}</div>`;
    return layout({siteName:runtimeSettings.siteName(),active:`settings-${section}`,title:titles[section][0],subtitle:titles[section][1],body});
}
async function saveSetting(key,value,req,{merge=false}={}) {
    const conflict=merge?'setting_value=platform_settings.setting_value || EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()':'setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()';
    await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at) VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(setting_key) DO UPDATE SET ${conflict}`,[key,JSON.stringify(value),req.session.authUserId]);
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.settings.update',$2,$2,$3::jsonb)`,[req.session.authUserId,key,JSON.stringify(value)]);
}
function createAdminOriginalSettingsRouter() {
    const router=express.Router();router.use('/admin/settings',gate);
    router.get('/admin/settings',async(req,res,next)=>{try{res.setHeader('Cache-Control','no-store, private, max-age=0');return res.send(page(req,await load()));}catch(error){return next(error);}});
    router.post('/admin/settings/admin-defaults',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const requested=String(req.body.defaultPlanCode||''),available=await query("SELECT code FROM plans WHERE active=TRUE AND audience IN ('direct','both') ORDER BY CASE WHEN code=$1 THEN 0 ELSE 1 END,sort_order,price_minor,name LIMIT 1",[requested]),serverClass=['premium','free','custom'].includes(req.body.defaultServerClass)?req.body.defaultServerClass:'premium';await saveSetting('admin_defaults',{defaultPlanCode:available.rows[0]?.code||'',defaultServerClass:serverClass,defaultServerPriority:int(req.body.defaultServerPriority,0,10000,100),defaultServerMaxUsers:int(req.body.defaultServerMaxUsers,0,100000,0),expiringWindowDays:int(req.body.expiringWindowDays,1,30,3),recentCustomerLimit:int(req.body.recentCustomerLimit,5,50,12)},req);return res.redirect('/admin/settings?section=general&message='+encodeURIComponent('Admin defaults saved.'));}catch(error){return res.redirect('/admin/settings?section=general&error='+encodeURIComponent(error.message||'Admin defaults could not be saved safely.'));}});
    router.post('/admin/settings/platform',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await runtimeSettings.ensureLoaded();await saveSetting('platform',{siteName:cleanSiteName(req.body.siteName),storefrontEnabled:req.body.storefrontEnabled==='on',publicRegistration:runtimeSettings.publicRegistrationOpen(),requireEmailVerification:runtimeSettings.requireEmailVerification()},req,{merge:true});await runtimeSettings.reload();return res.redirect('/admin/settings?section=general&message='+encodeURIComponent('General settings saved.'));}catch(error){return res.redirect('/admin/settings?section=general&error='+encodeURIComponent(error.message));}});
    router.post('/admin/settings/registration',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await runtimeSettings.ensureLoaded();const publicRegistration=req.body.registrationAccess==='public',requireEmailVerification=req.body.requireEmailVerification==='on';if(publicRegistration&&requireEmailVerification){const mail=await emailSettings.status();if(!mail.configured)throw new Error('Configure transactional email before enabling verified public registration.');}await saveSetting('platform',{publicRegistration,requireEmailVerification},req,{merge:true});await runtimeSettings.reload();return res.redirect('/admin/settings?section=security&message='+encodeURIComponent(`Registration policy saved: ${registrationLabel({publicRegistration,requireEmailVerification})}.`));}catch(error){return res.redirect('/admin/settings?section=security&error='+encodeURIComponent(error.message));}});
    return router;
}
module.exports={createAdminOriginalSettingsRouter,load,page,registrationLabel};
