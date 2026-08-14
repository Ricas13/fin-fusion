'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const auth = require('../auth/service');
const runtimeSettings = require('./runtime-settings');
const { layout, esc } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function notice(value, kind = '') { return value ? `<div class="notice ${kind}">${esc(value)}</div>` : ''; }
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function stepInput() {
    return `<div class="formGroup"><label>Authenticator / recovery code <span class="muted">(only needed if 2FA is enabled)</span></label><input class="input" name="code" autocomplete="one-time-code"></div>`;
}
async function requireStep(req) { return auth.verifySecondFactor(req.session.authUserId, req.body.code, req); }
function int(value, min, max, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

async function load() {
    await runtimeSettings.ensureLoaded();
    const [rows, plans] = await Promise.all([
        query("SELECT setting_key,setting_value FROM platform_settings WHERE setting_key IN ('storefront','storefront_features','reseller_defaults','admin_defaults')"),
        query("SELECT code,name FROM plans WHERE active=TRUE AND audience IN ('direct','both') ORDER BY sort_order,price_minor,name")
    ]);
    const settings = Object.fromEntries(rows.rows.map(row => [row.setting_key, row.setting_value]));
    const fallbackPlan = plans.rows[0]?.code || '';
    return {
        store: settings.storefront || {},
        features: Array.isArray(settings.storefront_features) ? settings.storefront_features : [],
        reseller: { credits: 0, trialCredits: 0, ...(settings.reseller_defaults || {}) },
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
            storefrontEnabled: runtimeSettings.storefrontEnabled(),
            publicRegistration: runtimeSettings.publicRegistrationOpen(),
            requireEmailVerification: runtimeSettings.requireEmailVerification(),
            entitlementJobIntervalMinutes: Math.round(runtimeSettings.entitlementJobIntervalMs() / 60000),
            serverHealthIntervalMinutes: Math.round(runtimeSettings.serverHealthIntervalMs() / 60000),
            overseerrUrl: runtimeSettings.overseerrUrl()
        },
        plans: plans.rows
    };
}

function status(label, value, kind = 'accent', hint = '') {
    return `<div class="compact-item"><div><div class="compact-title">${esc(label)}</div><div class="compact-meta">${esc(hint)}</div></div><span class="pill ${kind}">${esc(value)}</span></div>`;
}

function page(req, data) {
    const s = data.store;
    const f = data.features;
    const r = data.reseller;
    const a = data.admin;
    const pf = data.platform;
    const planOptions = data.plans.map(plan => `<option value="${esc(plan.code)}" ${a.defaultPlanCode === plan.code ? 'selected' : ''}>${esc(plan.name)} · ${esc(plan.code)}</option>`).join('');

    const body = `${notice(req.query.message, 'success')}${notice(req.query.error, 'error')}
    <div class="settings-grid">
        <section class="settings-card">
            <div class="card-header"><div><h3>Storefront</h3><div class="settings-hint">Public homepage copy and support details. Publishing is controlled separately below.</div></div><a class="button secondary" href="/" target="_blank" rel="noopener">Preview</a></div>
            <div class="card-body"><form method="post" action="/admin/settings/storefront">${csrfInput(req)}
                <div class="formGroup"><label>Hero title</label><input class="input" name="heroTitle" maxlength="140" value="${esc(s.heroTitle || '')}"></div>
                <div class="formGroup"><label>Hero subtitle</label><textarea class="input" name="heroSubtitle" maxlength="500">${esc(s.heroSubtitle || '')}</textarea></div>
                <div class="formGrid">
                    <div class="formGroup"><label>Features heading</label><input class="input" name="featureTitle" value="${esc(s.featureTitle || '')}"></div>
                    <div class="formGroup"><label>Support email</label><input class="input" type="email" name="supportEmail" value="${esc(s.supportEmail || '')}"></div>
                </div>
                <div class="formGroup"><label>Announcement</label><input class="input" name="announcement" maxlength="200" value="${esc(s.announcement || '')}"></div>
                <div class="formGroup"><label>Features · one per line</label><textarea class="input" name="features" rows="7">${esc(f.join('\n'))}</textarea></div>
                <div class="formGroup"><label>Verification code <span class="muted">(only when enabled)</span></label><input class="input" name="code" autocomplete="one-time-code"></div>
                <button class="button">Save storefront</button>
            </form></div>
        </section>

        <section class="settings-card">
            <div class="card-header"><div><h3>Admin defaults</h3><div class="settings-hint">Defaults for manual customer and server workflows</div></div></div>
            <div class="card-body"><form method="post" action="/admin/settings/admin-defaults">${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Default customer plan</label><select class="input" name="defaultPlanCode">${planOptions || '<option value="">No active direct plans</option>'}</select></div>
                    <div class="formGroup"><label>Default server class</label><select class="input" name="defaultServerClass">${['premium','free','custom'].map(x => `<option ${a.defaultServerClass === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
                    <div class="formGroup"><label>Default server priority</label><input class="input" type="number" min="0" max="10000" name="defaultServerPriority" value="${esc(a.defaultServerPriority)}"></div>
                    <div class="formGroup"><label>Default max users · 0 = unlimited</label><input class="input" type="number" min="0" max="100000" name="defaultServerMaxUsers" value="${esc(a.defaultServerMaxUsers)}"></div>
                    <div class="formGroup"><label>Expiring-soon window · days</label><input class="input" type="number" min="1" max="30" name="expiringWindowDays" value="${esc(a.expiringWindowDays)}"></div>
                    <div class="formGroup"><label>Recent customers on dashboard</label><input class="input" type="number" min="5" max="50" name="recentCustomerLimit" value="${esc(a.recentCustomerLimit)}"></div>
                </div>${stepInput()}<button class="button">Save admin defaults</button>
            </form></div>
        </section>

        <section class="settings-card">
            <div class="card-header"><div><h3>Reseller defaults</h3><div class="settings-hint">Starting balances for newly created resellers</div></div><a class="button secondary" href="/admin/reseller-management">Manage resellers</a></div>
            <div class="card-body"><form method="post" action="/admin/settings/reseller-defaults">${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Regular credits</label><input class="input" type="number" min="0" max="100000" name="credits" value="${esc(r.credits)}"></div>
                    <div class="formGroup"><label>Trial credits</label><input class="input" type="number" min="0" max="20" name="trialCredits" value="${esc(r.trialCredits)}"></div>
                </div>${stepInput()}<button class="button">Save reseller defaults</button>
            </form></div>
        </section>

        <section class="settings-card">
            <div class="card-header"><div><h3>Platform &amp; integrations</h3><div class="settings-hint">Customer-facing modules are explicit choices, not implied by the presence of database tables.</div></div></div>
            <div class="card-body"><form method="post" action="/admin/settings/platform">${csrfInput(req)}
                <div class="toggleGrid">
                    <label class="toggleRow"><input type="checkbox" name="storefrontEnabled" ${pf.storefrontEnabled ? 'checked' : ''}><span><strong>Publish public storefront</strong><small class="muted">New clean installs leave this disabled until you intentionally publish it.</small></span></label>
                    <label class="toggleRow"><input type="checkbox" name="publicRegistration" ${pf.publicRegistration ? 'checked' : ''}><span><strong>Public registration open</strong><small class="muted">Invitations and admin onboarding continue to work while this is off.</small></span></label>
                    <label class="toggleRow"><input type="checkbox" name="requireEmailVerification" ${pf.requireEmailVerification ? 'checked' : ''}><span><strong>Require email verification</strong></span></label>
                </div>
                <div class="formGrid">
                    <div class="formGroup"><label>Entitlement reconcile interval · minutes</label><input class="input" type="number" min="1" max="180" name="entitlementJobIntervalMinutes" value="${esc(pf.entitlementJobIntervalMinutes)}"></div>
                    <div class="formGroup"><label>Server health-check interval · minutes</label><input class="input" type="number" min="1" max="180" name="serverHealthIntervalMinutes" value="${esc(pf.serverHealthIntervalMinutes)}"></div>
                    <div class="formGroup"><label>External request site URL <span class="muted">(Overseerr/Seerr)</span></label><input class="input" type="url" name="overseerrUrl" maxlength="500" placeholder="https://requests.example.com" value="${esc(pf.overseerrUrl)}"></div>
                </div>
                <p class="settings-hint">Interval and toggle changes take effect immediately, no restart required.</p>${stepInput()}<button class="button">Save platform settings</button>
            </form></div>
        </section>

        <section class="settings-card">
            <div class="card-header"><div><h3>Deployment &amp; integrations</h3><div class="settings-hint">Sensitive values remain server-side</div></div></div>
            <div class="card-body">
                ${status('Stripe', process.env.STRIPE_API_KEY || process.env.STRIPE_RESTRICTED_KEY ? 'Configured' : 'Not configured', process.env.STRIPE_API_KEY || process.env.STRIPE_RESTRICTED_KEY ? 'good' : 'warn', 'Secrets are never rendered here')}
                ${status('PayPal', process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? 'Configured' : 'Not configured', process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? 'good' : 'warn', 'Secrets are never rendered here')}
                ${status('Email', process.env.SMTP_URL ? 'Configured' : 'Not configured', process.env.SMTP_URL ? 'good' : 'warn', 'Optional SMTP delivery')}
                ${status('Telegram', process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? 'Configured' : 'Not configured', process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? 'good' : 'warn', 'Configure credentials on the server')}
                ${status('Activity mode', String(process.env.STREAM_POLICY_MODE || 'observe').toUpperCase(), 'accent', 'Playback-policy worker mode')}
                <div class="quick-actions" style="margin-top:12px">
                    <a class="quick-action" href="/admin/setup"><strong>Setup</strong><span>Feature readiness and first-run checklist</span></a>
                    <a class="quick-action" href="/admin/plans"><strong>Plans</strong><span>Prices, streams and reseller credits</span></a>
                    <a class="quick-action" href="/admin/payments"><strong>Payments</strong><span>Provider status and events</span></a>
                    <a class="quick-action" href="/admin/notifications"><strong>Notifications</strong><span>Event delivery preferences</span></a>
                    <a class="quick-action" href="/admin/security"><strong>Security</strong><span>Sessions and account controls</span></a>
                </div>
            </div>
        </section>
    </div>`;

    return layout({ siteName: process.env.SITE_NAME || 'CAPTaINFiN', active: 'settings', title: 'Settings', subtitle: 'Business defaults, storefront and integration state', body });
}

async function saveSetting(key, value, req) {
    await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at) VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [key, JSON.stringify(value), req.session.authUserId]);
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.settings.update',$2,$2,$3::jsonb)`, [req.session.authUserId, key, JSON.stringify(value)]);
}

function createAdminOriginalSettingsRouter() {
    const router = express.Router();
    router.use('/admin/settings', gate);

    router.get('/admin/settings', async (req, res, next) => {
        try {
            res.setHeader('Cache-Control', 'no-store, private, max-age=0');
            return res.send(page(req, await load()));
        } catch (error) { return next(error); }
    });

    router.post('/admin/settings/admin-defaults', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (!(await requireStep(req))) throw new Error('verification');
            const requested = String(req.body.defaultPlanCode || '');
            const available = await query("SELECT code FROM plans WHERE active=TRUE AND audience IN ('direct','both') ORDER BY CASE WHEN code=$1 THEN 0 ELSE 1 END,sort_order,price_minor,name LIMIT 1", [requested]);
            const allowedPlan = available.rows[0]?.code || '';
            const serverClass = ['premium','free','custom'].includes(req.body.defaultServerClass) ? req.body.defaultServerClass : 'premium';
            const value = {
                defaultPlanCode: allowedPlan,
                defaultServerClass: serverClass,
                defaultServerPriority: int(req.body.defaultServerPriority, 0, 10000, 100),
                defaultServerMaxUsers: int(req.body.defaultServerMaxUsers, 0, 100000, 0),
                expiringWindowDays: int(req.body.expiringWindowDays, 1, 30, 3),
                recentCustomerLimit: int(req.body.recentCustomerLimit, 5, 50, 12)
            };
            await saveSetting('admin_defaults', value, req);
            return res.redirect('/admin/settings?message=' + encodeURIComponent('Admin defaults saved.'));
        } catch (error) {
            return res.redirect('/admin/settings?error=' + encodeURIComponent(error.message === 'verification' ? 'Verification failed.' : 'Admin defaults could not be saved safely.'));
        }
    });

    router.post('/admin/settings/reseller-defaults', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (!(await requireStep(req))) throw new Error('verification');
            const value = { credits: int(req.body.credits, 0, 100000, 0), trialCredits: int(req.body.trialCredits, 0, 20, 0) };
            await saveSetting('reseller_defaults', value, req);
            return res.redirect('/admin/settings?message=' + encodeURIComponent('Reseller defaults saved.'));
        } catch (error) {
            return res.redirect('/admin/settings?error=' + encodeURIComponent(error.message === 'verification' ? 'Verification failed.' : 'Reseller defaults could not be saved safely.'));
        }
    });

    router.post('/admin/settings/platform', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (!(await requireStep(req))) throw new Error('verification');
            const rawOverseerrUrl = String(req.body.overseerrUrl || '').trim().slice(0, 500);
            let overseerrUrl = '';
            if (rawOverseerrUrl) {
                let parsed;
                try { parsed = new URL(rawOverseerrUrl); }
                catch { throw new Error('The external request URL is not a valid URL.'); }
                if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The external request URL must use http:// or https://.');
                overseerrUrl = parsed.href;
            }
            const value = {
                storefrontEnabled: req.body.storefrontEnabled === 'on',
                publicRegistration: req.body.publicRegistration === 'on',
                requireEmailVerification: req.body.requireEmailVerification === 'on',
                entitlementJobIntervalMinutes: int(req.body.entitlementJobIntervalMinutes, 1, 180, 5),
                serverHealthIntervalMinutes: int(req.body.serverHealthIntervalMinutes, 1, 180, 5),
                overseerrUrl
            };
            await saveSetting('platform', {
                storefrontEnabled: value.storefrontEnabled,
                publicRegistration: value.publicRegistration,
                requireEmailVerification: value.requireEmailVerification,
                entitlementJobIntervalMs: value.entitlementJobIntervalMinutes * 60000,
                serverHealthIntervalMs: value.serverHealthIntervalMinutes * 60000,
                overseerrUrl: value.overseerrUrl
            }, req);
            await runtimeSettings.reload();
            return res.redirect('/admin/settings?message=' + encodeURIComponent('Platform settings saved.'));
        } catch (error) {
            return res.redirect('/admin/settings?error=' + encodeURIComponent(error.message === 'verification' ? 'Verification failed.' : error.message));
        }
    });

    return router;
}

module.exports = { createAdminOriginalSettingsRouter };
