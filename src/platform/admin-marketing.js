'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { query } = require('../db');
const campaigns = require('../marketing/campaigns');
const operations = require('./operations-settings');
const runtimeSettings = require('./runtime-settings');
const emailSettings = require('../integrations/email-settings');
const { esc, layout } = require('./admin-html');

function gate(req, res, next) {
    return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId
        ? next()
        : res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function token(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function when(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function statusPill(value) {
    const status = String(value || 'draft');
    const cls = status === 'scheduled' ? 'accent' : status === 'queued' || status === 'sent' ? 'good' : status === 'cancelled' ? 'bad' : 'warn';
    return `<span class="pill ${cls}">${esc(status)}</span>`;
}
const segmentLabels = Object.freeze({
    no_active_subscription: 'No current subscription',
    expired_subscription: 'Previous customer, no current subscription',
    active_subscription: 'Current subscribers',
    all_opted_in: 'All opted-in customers'
});
const serviceLabels = Object.freeze({ jellyfin: 'Jellyfin', stremio: 'Stremio', bundle: 'Legacy bundle' });
const billingLabels = Object.freeze({ trial: 'Trial', month: 'Monthly', '6_months': '6 months', year: 'Yearly', custom: 'Custom' });
const marketingStyles = `<link rel="stylesheet" href="/css/admin-marketing.css"><script src="/js/admin-marketing.js" defer></script>`;

async function storefrontUrl(req) {
    try { return await operations.absoluteUrl(req, '/'); } catch { return ''; }
}
async function discountOptions() {
    return (await query(`SELECT code,description FROM discount_codes WHERE active=TRUE AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY code`)).rows;
}
async function planOptions() {
    return (await query(`SELECT id,name,code,service_type,price_minor,billing_interval FROM plans ORDER BY name,code LIMIT 750`)).rows;
}
function ruleSummary(raw = {}) {
    const rules = campaigns.normalizeRules(raw || {});
    const parts = [];
    if (rules.serviceType) parts.push(serviceLabels[rules.serviceType] || rules.serviceType);
    if (rules.planId) parts.push('specific plan');
    if (rules.priceType) parts.push(rules.priceType === 'free' ? 'free plans' : 'paid plans');
    if (rules.billingInterval) parts.push(billingLabels[rules.billingInterval] || rules.billingInterval);
    if (rules.subscriptionStatus) parts.push(`status ${rules.subscriptionStatus}`);
    if (rules.accountAgeDays !== undefined) parts.push(`account ≥ ${rules.accountAgeDays}d`);
    if (rules.lapsedDays !== undefined) parts.push(`lapsed ≥ ${rules.lapsedDays}d`);
    if (rules.expiresWithinDays !== undefined) parts.push(`expires ≤ ${rules.expiresWithinDays}d`);
    if (rules.inactivePlaybackDays !== undefined) parts.push(`no playback ${rules.inactivePlaybackDays}d`);
    return parts.length ? parts.join(' · ') : 'No additional filters';
}
function segmentOptions(selected = 'all_opted_in') {
    return Object.entries(segmentLabels).map(([key, label]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
}
function planSelectOptions(plans, selected = '') {
    return `<option value="">Any plan</option>${plans.map(plan => `<option value="${esc(plan.id)}" ${String(plan.id) === String(selected || '') ? 'selected' : ''}>${esc(plan.name)} · ${esc(plan.code || '')}</option>`).join('')}`;
}
function ruleFields(plans, rules = {}, { preview = false } = {}) {
    const attrs = preview ? ' data-marketing-audience-field' : '';
    const value = key => rules?.[key] == null ? '' : rules[key];
    return `<div class="marketingRuleGrid">
        <label><span>Service</span><select class="input" name="serviceType"${attrs}><option value="">Any service</option>${Object.entries(serviceLabels).map(([key, label]) => `<option value="${key}" ${value('serviceType') === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label><span>Plan</span><select class="input" name="planId"${attrs}>${planSelectOptions(plans, value('planId'))}</select></label>
        <label><span>Price type</span><select class="input" name="priceType"${attrs}><option value="">Free + paid</option><option value="free" ${value('priceType') === 'free' ? 'selected' : ''}>Free</option><option value="paid" ${value('priceType') === 'paid' ? 'selected' : ''}>Paid</option></select></label>
        <label><span>Billing</span><select class="input" name="billingInterval"${attrs}><option value="">Any interval</option>${Object.entries(billingLabels).map(([key, label]) => `<option value="${key}" ${value('billingInterval') === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label><span>Subscription status</span><select class="input" name="subscriptionStatus"${attrs}><option value="">Any status</option>${['active','trialing','past_due','paused','cancelled','expired'].map(key => `<option value="${key}" ${value('subscriptionStatus') === key ? 'selected' : ''}>${esc(key.replace('_',' '))}</option>`).join('')}</select></label>
        <label><span>Account age ≥ days</span><input class="input" type="number" min="0" max="3650" name="accountAgeDays" value="${esc(value('accountAgeDays'))}"${attrs}></label>
        <label><span>Lapsed ≥ days</span><input class="input" type="number" min="0" max="3650" name="lapsedDays" value="${esc(value('lapsedDays'))}"${attrs}></label>
        <label><span>Expires within days</span><input class="input" type="number" min="1" max="365" name="expiresWithinDays" value="${esc(value('expiresWithinDays'))}"${attrs}></label>
        <label><span>No playback for days</span><input class="input" type="number" min="1" max="3650" name="inactivePlaybackDays" value="${esc(value('inactivePlaybackDays'))}"${attrs}></label>
    </div>`;
}
function rulesFromBody(body = {}) {
    return campaigns.normalizeRules({
        serviceType: body.serviceType,
        planId: body.planId,
        priceType: body.priceType,
        billingInterval: body.billingInterval,
        subscriptionStatus: body.subscriptionStatus,
        accountAgeDays: body.accountAgeDays,
        lapsedDays: body.lapsedDays,
        expiresWithinDays: body.expiresWithinDays,
        inactivePlaybackDays: body.inactivePlaybackDays
    });
}
function rulesFromQuery(queryObject = {}) { return rulesFromBody(queryObject); }
function marketingTabs(active) {
    const links = [
        ['overview', 'Overview', '/admin/marketing'],
        ['campaigns', 'Campaigns', '/admin/marketing/campaigns'],
        ['segments', 'Segments', '/admin/marketing/segments'],
        ['templates', 'Templates', '/admin/marketing/templates']
    ];
    return `<nav class="workflowTabs marketingTabs" aria-label="Marketing"><div class="workflowTabsScroller">${links.map(([key, label, href]) => `<a class="workflowTab ${active === key ? 'active' : ''}" href="${href}" ${active === key ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</div></nav>`;
}
function campaignActions(req, row) {
    const queue = `<form method="post" action="/admin/marketing/${esc(row.id)}/queue" data-confirm="Queue this campaign to the customers who are eligible and opted in right now?">${token(req)}<button class="button secondary btn-sm">Queue now</button></form>`;
    const schedule = label => `<form method="post" action="/admin/marketing/${esc(row.id)}/schedule" data-marketing-schedule-form class="marketingScheduleForm">${token(req)}<input class="input compact" type="datetime-local" data-marketing-local-time required aria-label="Campaign schedule time"><input type="hidden" name="scheduledFor" data-marketing-scheduled-iso><button class="button secondary btn-sm">${esc(label)}</button></form>`;
    if (row.status === 'draft') return `<div class="marketingActions">${queue}${schedule('Schedule')}</div>`;
    if (row.status === 'scheduled') return `<div class="marketingActions">${queue}${schedule('Change time')}<form method="post" action="/admin/marketing/${esc(row.id)}/unschedule">${token(req)}<button class="button secondary btn-sm">Return to draft</button></form></div>`;
    if (row.status === 'queued') return `<div class="marketingActions">${queue}</div>`;
    return '—';
}
function campaignTable(req, rows, { limit = null } = {}) {
    const shown = limit ? rows.slice(0, limit) : rows;
    if (!shown.length) return '<div class="empty">No marketing campaigns yet.</div>';
    return `<div class="tableWrap"><table class="dataTable responsiveTable marketingCampaignTable"><thead><tr><th>Campaign</th><th>Audience</th><th>Status</th><th>Recipients</th><th>Created</th><th>Action</th></tr></thead><tbody>${shown.map(row => `<tr><td data-label="Campaign"><strong>${esc(row.name)}</strong><div class="subText">${esc(row.subject)}</div>${row.discount_code ? `<div class="subText">Discount: ${esc(row.discount_code)}</div>` : ''}</td><td data-label="Audience"><strong>${esc(segmentLabels[row.segment_key] || row.segment_key)}</strong><div class="subText">${esc(ruleSummary(row.segment_rules || {}))}</div></td><td data-label="Status">${statusPill(row.status)}${row.scheduled_for ? `<div class="subText">${esc(when(row.scheduled_for))}</div>` : ''}${row.schedule_last_error ? `<div class="errorText">${esc(row.schedule_last_error)}</div>` : ''}</td><td data-label="Recipients"><strong>${Number(row.queued_count || 0)}</strong> queued<div class="subText">${Number(row.recipient_count || 0)} snapshotted · ${Number(row.recipients_suppressed || 0)} suppressed</div></td><td data-label="Created">${esc(when(row.created_at))}</td><td data-label="Action">${campaignActions(req, row)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function overviewPage(req) {
    await runtimeSettings.ensureLoaded();
    const [summary, rows, smtp] = await Promise.all([campaigns.overview(), campaigns.list(), emailSettings.status().catch(() => ({ configured: false }))]);
    const failed = Number(summary.failed || 0);
    const body = `${notice(req)}${marketingTabs('overview')}<section class="marketingHero ${failed ? 'needsAttention' : ''}"><div><div class="eyebrow">Marketing control centre</div><h2>${failed ? `${failed} marketing email ${failed === 1 ? 'delivery needs' : 'deliveries need'} attention` : 'Campaigns, audiences and reusable content in one place'}</h2><p>Promotional email is consent-aware and uses the same encrypted delivery outbox as the rest of CAPTAiNFiN. Transactional account and payment messages remain separate.</p></div><div class="marketingHeroActions"><a class="button" href="/admin/marketing/campaigns#new-campaign">Create campaign</a><a class="button secondary" href="/admin/notifications">Email delivery</a></div></section>
        <div class="metrics marketingMetrics"><div class="metric"><div class="metricLabel">Opted-in audience</div><div class="metricValue">${Number(summary.opted_in || 0)}</div><div class="subText">customers who can receive promotions</div></div><div class="metric"><div class="metricLabel">Scheduled</div><div class="metricValue">${Number(summary.scheduled || 0)}</div><div class="subText">waiting for automation worker</div></div><div class="metric"><div class="metricLabel">Marketing sent</div><div class="metricValue">${Number(summary.sent || 0)}</div><div class="subText">outbox deliveries</div></div><div class="metric"><div class="metricLabel">Delivery failures</div><div class="metricValue ${failed ? 'statusBad' : ''}">${failed}</div><div class="subText">${smtp.configured ? 'SMTP configured' : 'SMTP not configured'}</div></div></div>
        <section class="section"><div class="sectionHead"><div><h2>Build the next campaign</h2><div class="muted">Keep audiences and message content reusable instead of rebuilding every send.</div></div></div><div class="marketingQuickGrid"><a class="quick-action" href="/admin/marketing/campaigns#new-campaign"><strong>Campaigns</strong><span>Compose, test, schedule or queue a promotion.</span></a><a class="quick-action" href="/admin/marketing/segments"><strong>Segments</strong><span>Save dynamic customer audiences using safe business filters.</span></a><a class="quick-action" href="/admin/marketing/templates"><strong>Templates</strong><span>Reuse approved subject lines and message content.</span></a></div></section>
        <section class="section"><div class="sectionHead"><div><h2>Recent campaigns</h2><div class="muted">Current audience membership and consent are checked again at send time.</div></div><a class="button secondary btn-sm" href="/admin/marketing/campaigns">View all</a></div>${campaignTable(req, rows, { limit: 8 })}</section>${marketingStyles}`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'marketing-overview', title: 'Marketing', subtitle: 'Consent-aware campaigns, reusable audiences and email templates', body });
}

async function campaignsPage(req) {
    await runtimeSettings.ensureLoaded();
    const [rows, discounts, savedSegments, templates, plans] = await Promise.all([campaigns.list(), discountOptions(), campaigns.listSegments({ withCounts: true }), campaigns.listTemplates(), planOptions()]);
    const body = `${notice(req)}${marketingTabs('campaigns')}<section class="section" id="new-campaign"><div class="sectionHead"><div><h2>Create campaign</h2><div class="muted">Choose a saved segment for repeatable targeting, or build a one-off audience below. Preview counts are live; recipients are not reserved until queue time.</div></div></div><form class="formPanel marketingComposer" method="post" action="/admin/marketing/campaigns" data-marketing-campaign-form>${token(req)}
        <div class="marketingComposerGrid"><label><span>Campaign name</span><input class="input" name="name" maxlength="160" required placeholder="September win-back"></label><label><span>Saved segment</span><select class="input" name="segmentId" data-marketing-saved-segment><option value="">Custom one-off audience</option>${savedSegments.map(row => `<option value="${esc(row.id)}">${esc(row.name)} · ${Number(row.current_count || 0)} now</option>`).join('')}</select></label><label><span>Base audience</span><select class="input" name="segmentKey" data-marketing-audience-field>${segmentOptions('all_opted_in')}</select></label><label><span>Template</span><select class="input" name="templateId" data-marketing-template-select><option value="">Write this message manually</option>${templates.map(row => `<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('')}</select></label><label><span>Discount code</span><select class="input" name="discountCode"><option value="">No discount code</option>${discounts.map(row => `<option value="${esc(row.code)}">${esc(row.code)}${row.description ? ` · ${esc(row.description)}` : ''}</option>`).join('')}</select></label><div class="marketingAudienceCount"><span>Current matching audience</span><strong data-marketing-audience-count>—</strong><small data-marketing-audience-status>Opted-in customers only</small></div></div>
        <details class="operatorDetails marketingAudienceBuilder"><summary><span>Audience filters</span><small>Optional · service, plan, lifecycle and activity</small></summary><div class="operatorDetailsBody">${ruleFields(plans, {}, { preview: true })}</div></details>
        <label class="marketingFull"><span>Email subject</span><input class="input" name="subject" maxlength="300" data-marketing-subject placeholder="Come back with 20% off"></label><label class="marketingFull"><span>Message</span><textarea class="input" name="bodyText" rows="8" maxlength="100000" data-marketing-body placeholder="We'd love to have you back…"></textarea></label>
        <div class="marketingSendRow"><label><span>Test recipient</span><input class="input" type="email" name="testTo" placeholder="you@example.com"></label><button class="button secondary" type="submit" formaction="/admin/marketing/campaigns/test" formnovalidate>Send test</button><button class="button" type="submit">Save draft</button></div></form></section>
        <section class="section"><div class="sectionHead"><div><h2>Campaigns</h2><div class="muted">Scheduling uses the existing automation worker; actual email delivery uses the encrypted retrying outbox.</div></div><span class="muted">${rows.length} campaign${rows.length === 1 ? '' : 's'}</span></div>${campaignTable(req, rows)}</section>${marketingStyles}`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'marketing-campaigns', title: 'Campaigns', subtitle: 'Compose, test, schedule and safely queue promotional email', body });
}

function segmentEditor(req, row, plans) {
    return `<details class="operatorDetails marketingSavedItem"><summary><span><strong>${esc(row.name)}</strong><small>${Number(row.current_count || 0)} customers now · ${esc(segmentLabels[row.base_segment_key] || row.base_segment_key)}</small></span><span class="pill accent">Dynamic</span></summary><div class="operatorDetailsBody"><form method="post" action="/admin/marketing/segments/${esc(row.id)}" class="marketingSavedForm">${token(req)}<label><span>Name</span><input class="input" name="name" maxlength="160" required value="${esc(row.name)}"></label><label><span>Base audience</span><select class="input" name="baseSegmentKey">${segmentOptions(row.base_segment_key)}</select></label>${ruleFields(plans, row.rules || {})}<div class="buttonRow"><button class="button" type="submit">Save segment</button></div></form><form method="post" action="/admin/marketing/segments/${esc(row.id)}/delete" data-confirm="Delete this saved marketing segment? Existing campaigns keep their snapshotted rules.">${token(req)}<button class="button danger btn-sm" type="submit">Delete segment</button></form></div></details>`;
}
async function segmentsPage(req) {
    await runtimeSettings.ensureLoaded();
    const [rows, plans] = await Promise.all([campaigns.listSegments({ withCounts: true }), planOptions()]);
    const body = `${notice(req)}${marketingTabs('segments')}<section class="section"><div class="sectionHead"><div><h2>Create saved segment</h2><div class="muted">Segments are dynamic definitions, not static email lists. Consent and matching customers are recalculated whenever a campaign is sent.</div></div></div><form class="formPanel marketingSavedForm" method="post" action="/admin/marketing/segments" data-marketing-segment-form>${token(req)}<div class="marketingComposerGrid"><label><span>Segment name</span><input class="input" name="name" maxlength="160" required placeholder="Lapsed Jellyfin customers"></label><label><span>Base audience</span><select class="input" name="baseSegmentKey" data-marketing-audience-field>${segmentOptions('all_opted_in')}</select></label><div class="marketingAudienceCount"><span>Current matching audience</span><strong data-marketing-audience-count>—</strong><small data-marketing-audience-status>Opted-in customers only</small></div></div>${ruleFields(plans, {}, { preview: true })}<div class="buttonRow"><button class="button" type="submit">Save segment</button></div></form></section><section class="section"><div class="sectionHead"><div><h2>Saved segments</h2><div class="muted">Reusable audiences keep campaign targeting consistent.</div></div><span class="muted">${rows.length} saved</span></div>${rows.length ? `<div class="marketingSavedStack">${rows.map(row => segmentEditor(req, row, plans)).join('')}</div>` : '<div class="empty">No saved marketing segments yet.</div>'}</section>${marketingStyles}`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'marketing-segments', title: 'Segments', subtitle: 'Reusable, consent-aware customer audiences built from safe business filters', body });
}
function templateEditor(req, row) {
    return `<details class="operatorDetails marketingSavedItem"><summary><span><strong>${esc(row.name)}</strong><small>${esc(row.subject)} · updated ${esc(when(row.updated_at))}</small></span><span class="pill">Template</span></summary><div class="operatorDetailsBody"><form method="post" action="/admin/marketing/templates/${esc(row.id)}" class="marketingTemplateForm">${token(req)}<label><span>Name</span><input class="input" name="name" maxlength="160" required value="${esc(row.name)}"></label><label><span>Subject</span><input class="input" name="subject" maxlength="300" required value="${esc(row.subject)}"></label><label class="marketingFull"><span>Message</span><textarea class="input" name="bodyText" rows="7" maxlength="100000" required>${esc(row.body_text)}</textarea></label><div class="buttonRow"><button class="button" type="submit">Save template</button></div></form><form method="post" action="/admin/marketing/templates/${esc(row.id)}/delete" data-confirm="Delete this marketing template? Existing campaigns keep their saved content.">${token(req)}<button class="button danger btn-sm" type="submit">Delete template</button></form></div></details>`;
}
async function templatesPage(req) {
    await runtimeSettings.ensureLoaded();
    const rows = await campaigns.listTemplates();
    const body = `${notice(req)}${marketingTabs('templates')}<section class="section"><div class="sectionHead"><div><h2>Create template</h2><div class="muted">Templates store plain message content; customer-specific names, discounts and storefront links are added safely at delivery time.</div></div></div><form class="formPanel marketingTemplateForm" method="post" action="/admin/marketing/templates">${token(req)}<label><span>Template name</span><input class="input" name="name" maxlength="160" required placeholder="Win-back offer"></label><label><span>Email subject</span><input class="input" name="subject" maxlength="300" required placeholder="We'd love to have you back"></label><label class="marketingFull"><span>Message</span><textarea class="input" name="bodyText" rows="8" maxlength="100000" required placeholder="Your reusable message…"></textarea></label><div class="buttonRow"><button class="button" type="submit">Save template</button></div></form></section><section class="section"><div class="sectionHead"><div><h2>Templates</h2><div class="muted">Choose one while composing a campaign, then adjust the copied content if needed.</div></div><span class="muted">${rows.length} saved</span></div>${rows.length ? `<div class="marketingSavedStack">${rows.map(row => templateEditor(req, row)).join('')}</div>` : '<div class="empty">No marketing templates yet.</div>'}</section>${marketingStyles}`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'marketing-templates', title: 'Templates', subtitle: 'Reusable promotional email content', body });
}

function redirect(res, path, key, value) { return res.redirect(`${path}?${key}=${encodeURIComponent(value)}`); }
function createAdminMarketingRouter() {
    const router = express.Router();
    router.use('/admin/marketing', gate, noStore);
    router.get('/admin/marketing', async (req, res, next) => { try { return res.send(await overviewPage(req)); } catch (error) { return next(error); } });
    router.get('/admin/marketing/campaigns', async (req, res, next) => { try { return res.send(await campaignsPage(req)); } catch (error) { return next(error); } });
    router.get('/admin/marketing/segments', async (req, res, next) => { try { return res.send(await segmentsPage(req)); } catch (error) { return next(error); } });
    router.get('/admin/marketing/templates', async (req, res, next) => { try { return res.send(await templatesPage(req)); } catch (error) { return next(error); } });
    router.get('/admin/marketing/audience-preview', async (req, res) => {
        try {
            let baseSegmentKey = req.query.segmentKey || req.query.baseSegmentKey || 'all_opted_in';
            let rules = rulesFromQuery(req.query);
            if (req.query.segmentId) {
                const saved = await campaigns.loadSegment(req.query.segmentId);
                if (!saved) return res.status(404).json({ ok: false, error: 'Saved segment not found.' });
                baseSegmentKey = saved.base_segment_key;
                rules = saved.rules || {};
            }
            const result = await campaigns.preview(baseSegmentKey, rules);
            return res.json({ ok: true, count: result.count });
        } catch (error) { return res.status(400).json({ ok: false, error: String(error.message || error).slice(0, 180) }); }
    });
    router.get('/admin/marketing/templates/:id', async (req, res) => {
        try {
            const row = await campaigns.loadTemplate(req.params.id);
            if (!row) return res.status(404).json({ ok: false, error: 'Template not found.' });
            return res.json({ ok: true, template: { id: row.id, name: row.name, subject: row.subject, bodyText: row.body_text } });
        } catch (error) { return res.status(400).json({ ok: false, error: String(error.message || error).slice(0, 180) }); }
    });
    router.post('/admin/marketing/campaigns', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            await campaigns.create({ name: req.body.name, subject: req.body.subject, bodyText: req.body.bodyText, discountCode: req.body.discountCode, segmentKey: req.body.segmentKey, segmentRules: rulesFromBody(req.body), segmentId: req.body.segmentId, templateId: req.body.templateId, adminUserId: req.session.authUserId });
            return redirect(res, '/admin/marketing/campaigns', 'message', 'Campaign draft saved. Review the live audience before scheduling or queueing it.');
        } catch (error) { return redirect(res, '/admin/marketing/campaigns', 'error', error.message); }
    });
    router.post('/admin/marketing/campaigns/test', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            let subject = req.body.subject;
            let bodyText = req.body.bodyText;
            if (req.body.templateId && (!String(subject || '').trim() || !String(bodyText || '').trim())) {
                const template = await campaigns.loadTemplate(req.body.templateId);
                if (!template) throw new Error('The selected template no longer exists.');
                subject = String(subject || '').trim() || template.subject;
                bodyText = String(bodyText || '').trim() || template.body_text;
            }
            await campaigns.sendTest({ to: req.body.testTo, subject, bodyText, discountCode: req.body.discountCode, storefrontUrl: await storefrontUrl(req) });
            return redirect(res, '/admin/marketing/campaigns', 'message', 'Marketing test email queued through the normal delivery outbox.');
        } catch (error) { return redirect(res, '/admin/marketing/campaigns', 'error', error.message); }
    });
    router.post('/admin/marketing/:id/queue', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const result = await campaigns.queue({ campaignId: req.params.id, adminUserId: req.session.authUserId, storefrontUrl: await storefrontUrl(req) });
            const suppressed = result.suppressed ? ` ${result.suppressed} previously snapshotted recipient${result.suppressed === 1 ? '' : 's'} suppressed because consent or audience eligibility changed.` : '';
            return redirect(res, '/admin/marketing/campaigns', 'message', `${result.queued} marketing email${result.queued === 1 ? '' : 's'} queued.${suppressed}`);
        } catch (error) { return redirect(res, '/admin/marketing/campaigns', 'error', error.message); }
    });
    router.post('/admin/marketing/:id/schedule', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const saved = await campaigns.schedule({ campaignId: req.params.id, scheduledFor: req.body.scheduledFor, adminUserId: req.session.authUserId });
            return redirect(res, '/admin/marketing/campaigns', 'message', `Campaign scheduled for ${when(saved.scheduled_for)}.`);
        } catch (error) { return redirect(res, '/admin/marketing/campaigns', 'error', error.message); }
    });
    router.post('/admin/marketing/:id/unschedule', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try { await campaigns.unschedule({ campaignId: req.params.id, adminUserId: req.session.authUserId }); return redirect(res, '/admin/marketing/campaigns', 'message', 'Campaign returned to draft.'); }
        catch (error) { return redirect(res, '/admin/marketing/campaigns', 'error', error.message); }
    });
    router.post('/admin/marketing/segments', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try { await campaigns.saveSegment({ name: req.body.name, baseSegmentKey: req.body.baseSegmentKey, rules: rulesFromBody(req.body), adminUserId: req.session.authUserId }); return redirect(res, '/admin/marketing/segments', 'message', 'Marketing segment saved.'); }
        catch (error) { return redirect(res, '/admin/marketing/segments', 'error', error.message); }
    });
    router.post('/admin/marketing/segments/:id', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try { await campaigns.saveSegment({ id: req.params.id, name: req.body.name, baseSegmentKey: req.body.baseSegmentKey, rules: rulesFromBody(req.body), adminUserId: req.session.authUserId }); return redirect(res, '/admin/marketing/segments', 'message', 'Marketing segment updated.'); }
        catch (error) { return redirect(res, '/admin/marketing/segments', 'error', error.message); }
    });
    router.post('/admin/marketing/segments/:id/delete', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try { await campaigns.deleteSegment({ id: req.params.id, adminUserId: req.session.authUserId }); return redirect(res, '/admin/marketing/segments', 'message', 'Marketing segment deleted.'); }
        catch (error) { return redirect(res, '/admin/marketing/segments', 'error', error.message); }
    });
    router.post('/admin/marketing/templates', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try { await campaigns.saveTemplate({ name: req.body.name, subject: req.body.subject, bodyText: req.body.bodyText, adminUserId: req.session.authUserId }); return redirect(res, '/admin/marketing/templates', 'message', 'Marketing template saved.'); }
        catch (error) { return redirect(res, '/admin/marketing/templates', 'error', error.message); }
    });
    router.post('/admin/marketing/templates/:id', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try { await campaigns.saveTemplate({ id: req.params.id, name: req.body.name, subject: req.body.subject, bodyText: req.body.bodyText, adminUserId: req.session.authUserId }); return redirect(res, '/admin/marketing/templates', 'message', 'Marketing template updated.'); }
        catch (error) { return redirect(res, '/admin/marketing/templates', 'error', error.message); }
    });
    router.post('/admin/marketing/templates/:id/delete', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try { await campaigns.deleteTemplate({ id: req.params.id, adminUserId: req.session.authUserId }); return redirect(res, '/admin/marketing/templates', 'message', 'Marketing template deleted.'); }
        catch (error) { return redirect(res, '/admin/marketing/templates', 'error', error.message); }
    });
    return router;
}

module.exports = { createAdminMarketingRouter, overviewPage, campaignsPage, segmentsPage, templatesPage, segmentLabels, rulesFromBody, storefrontUrl };
