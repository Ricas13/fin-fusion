'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');
const campaigns = require('../marketing/campaigns');
const customerFilters = require('../platform/customer-filters');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}

function csrfInput(req) {
    return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;
}

function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}

function pill(text, kind = '') {
    return `<span class="pill ${kind}">${esc(text)}</span>`;
}

function text(value, max = 200) {
    return String(value || '').trim().slice(0, max);
}

async function selectablePlans() {
    const result = await query(`SELECT id,code,name FROM plans WHERE archived_at IS NULL ORDER BY sort_order,name`);
    return result.rows;
}

async function selectableDiscounts() {
    const result = await query(`SELECT id,code,description FROM discount_codes WHERE active=TRUE AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY created_at DESC`);
    return result.rows;
}

function parseAudienceFilters(body) {
    const filters = {};
    if (body.planId && customerFilters.isUuid(body.planId)) filters.planId = body.planId;
    if (customerFilters.STATUS_VALUES.includes(body.status) || body.status === 'none') filters.status = body.status;
    if (body.isFreeTier === '1') filters.isFreeTier = true;
    return filters;
}

function audienceSummary(filters) {
    const parts = [];
    if (filters.planId) parts.push(`plan ${filters.planId}`);
    if (filters.status) parts.push(`status ${filters.status}`);
    if (filters.isFreeTier) parts.push('free tier');
    return parts.length ? parts.join(', ') : 'All customers';
}

function statusPill(status) {
    const kind = status === 'sent' || status === 'queued' ? 'good' : status === 'cancelled' ? 'bad' : status === 'scheduled' ? 'accent' : '';
    return pill(status, kind);
}

function campaignRow(row) {
    return `<tr>
        <td><a href="/admin/marketing/${esc(row.id)}"><strong>${esc(row.name)}</strong></a><div class="muted">${esc(row.subject)}</div></td>
        <td>${statusPill(row.status)}</td>
        <td>${esc(row.recipient_count)}</td>
        <td>${esc(row.queued_count)}</td>
        <td>${row.scheduled_for ? new Date(row.scheduled_for).toLocaleString('en-GB') : '—'}</td>
        <td>${new Date(row.created_at).toLocaleString('en-GB')}</td>
    </tr>`;
}

async function listPage(req) {
    await runtimeSettings.ensureLoaded();
    const [rows, plans, discounts] = await Promise.all([campaigns.list(), selectablePlans(), selectableDiscounts()]);

    const body = `${notice(req)}
        <div class="metrics">
            <div class="metric"><div class="metricLabel">Campaigns</div><div class="metricValue">${rows.length}</div></div>
            <div class="metric"><div class="metricLabel">Queued</div><div class="metricValue">${rows.filter(r => r.status === 'queued').length}</div></div>
            <div class="metric"><div class="metricLabel">Scheduled</div><div class="metricValue">${rows.filter(r => r.status === 'scheduled').length}</div></div>
        </div>
        <section class="section">
            <div class="sectionHead"><h2>New campaign</h2><span class="muted">Reaches only customers who have opted in to marketing messages, across whichever channels they've linked.</span></div>
            <form class="formPanel" method="post" action="/admin/marketing">
                ${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Name</label><input class="input" name="name" required minlength="3" maxlength="160" placeholder="Autumn discount push"></div>
                    <div class="formGroup"><label>Discount code <span class="muted">(optional)</span></label><select class="input" name="discountCodeId"><option value="">None</option>${discounts.map(d => `<option value="${esc(d.id)}">${esc(d.code)}${d.description ? ` — ${esc(d.description)}` : ''}</option>`).join('')}</select></div>
                </div>
                <div class="formGroup"><label>Subject</label><input class="input" name="subject" required minlength="3" maxlength="300" placeholder="A discount just for you"></div>
                <div class="formGroup"><label>Message</label><textarea class="input" name="bodyText" required maxlength="100000" rows="6" placeholder="Write the message body. The discount code, if chosen, is appended automatically."></textarea></div>
                <div class="sectionHead"><h3>Audience</h3></div>
                <div class="formGrid">
                    <div class="formGroup"><label>Plan</label><select class="input" name="planId"><option value="">Any plan</option>${plans.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>
                    <div class="formGroup"><label>Subscription status</label><select class="input" name="status"><option value="">Any status</option>${customerFilters.STATUS_VALUES.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}<option value="none">No subscription</option></select></div>
                    <div class="formGroup"><label class="toggleRow"><input type="checkbox" name="isFreeTier" value="1"><span>Free tier only</span></label></div>
                </div>
                <button class="button">Create draft campaign</button>
            </form>
        </section>
        <section class="section">
            <div class="sectionHead"><h2>Campaigns</h2><span class="muted">${rows.length} total</span></div>
            ${rows.length ? `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Campaign</th><th>Status</th><th>Recipients</th><th>Queued</th><th>Scheduled for</th><th>Created</th></tr></thead><tbody>${rows.map(campaignRow).join('')}</tbody></table></div>` : '<div class="empty">No campaigns yet.</div>'}
        </section>`;

    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'marketing',
        title: 'Marketing campaigns',
        subtitle: 'Discounts and offers for free and non-paying customers',
        body
    });
}

async function detailPage(req, data) {
    await runtimeSettings.ensureLoaded();
    const { campaign, recipients, deliveries, discountCode } = data;
    const canEdit = ['draft', 'scheduled', 'queued'].includes(campaign.status);
    const preview = canEdit ? await campaigns.preview(campaign.audience_filters || {}) : { count: recipients.length, sample: [] };

    const deliveryCounts = deliveries.reduce((acc, d) => { acc[d.channel] = acc[d.channel] || { queued: 0, suppressed: 0, failed: 0 }; if (acc[d.channel][d.status] !== undefined) acc[d.channel][d.status] += 1; return acc; }, {});

    const scheduleForm = campaign.status === 'draft'
        ? `<form class="formPanel" method="post" action="/admin/marketing/${esc(campaign.id)}/schedule">${csrfInput(req)}<div class="formGroup"><label>Schedule for</label><input class="input" type="datetime-local" name="scheduledFor" required></div><button class="button secondary">Schedule</button></form>`
        : campaign.status === 'scheduled'
            ? `<div class="notice warn">Scheduled for ${new Date(campaign.scheduled_for).toLocaleString('en-GB')}.</div><form method="post" action="/admin/marketing/${esc(campaign.id)}/unschedule">${csrfInput(req)}<button class="button secondary">Cancel schedule</button></form>`
            : '';

    const queueForm = ['draft', 'scheduled', 'queued'].includes(campaign.status)
        ? `<form method="post" action="/admin/marketing/${esc(campaign.id)}/queue" onsubmit="return confirm('Send this campaign to its current eligible audience now?')">${csrfInput(req)}<button class="button">Queue now</button></form>`
        : '';

    const body = `${notice(req)}
        <section class="section">
            <div class="sectionHead"><div><h2>${esc(campaign.name)}</h2><div class="muted">${esc(campaign.subject)}</div></div>${statusPill(campaign.status)}</div>
            <div class="formPanel"><div class="subText">Discount code: ${discountCode ? esc(discountCode.code) : 'None'}</div><div class="subText">Audience: ${esc(audienceSummary(campaign.audience_filters || {}))}</div><div class="subText">Message:</div><p>${esc(campaign.body_text)}</p></div>
            ${canEdit ? `<div class="notice">${preview.count} customer(s) currently eligible and opted in for this audience.</div>` : ''}
            <div class="buttonRow">${queueForm}${scheduleForm}</div>
        </section>
        <section class="section">
            <div class="sectionHead"><h2>Delivery</h2><span class="muted">${recipients.length} recipient(s) snapshotted, ${campaign.queued_count} queued</span></div>
            ${deliveries.length ? `<div class="tableWrap"><table class="dataTable"><thead><tr><th>Channel</th><th>Queued</th><th>Suppressed</th><th>Failed</th></tr></thead><tbody>${Object.entries(deliveryCounts).map(([channel, c]) => `<tr><td>${esc(channel)}</td><td>${c.queued}</td><td>${c.suppressed}</td><td>${c.failed}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Not queued yet.</div>'}
        </section>`;

    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'marketing',
        title: campaign.name,
        subtitle: 'Campaign detail',
        body,
        action: '<a class="button secondary" href="/admin/marketing">Back to campaigns</a>'
    });
}

function createAdminMarketingRouter() {
    const router = express.Router();
    router.use('/admin/marketing', gate, noStore);

    router.get('/admin/marketing', async (req, res, next) => {
        try { return res.send(await listPage(req)); } catch (error) { return next(error); }
    });

    router.post('/admin/marketing', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const audienceFilters = parseAudienceFilters(req.body);
            const created = await campaigns.create({
                name: text(req.body.name, 160),
                subject: text(req.body.subject, 300),
                bodyText: text(req.body.bodyText, 100000),
                discountCodeId: req.body.discountCodeId || null,
                audienceFilters,
                adminUserId: req.session.authUserId
            });
            return res.redirect(`/admin/marketing/${encodeURIComponent(created.id)}?message=${encodeURIComponent('Campaign created as a draft.')}`);
        } catch (error) {
            return res.redirect('/admin/marketing?error=' + encodeURIComponent(error.message));
        }
    });

    router.get('/admin/marketing/:id', async (req, res, next) => {
        try {
            const data = await campaigns.get(req.params.id);
            if (!data) return res.status(404).send('Campaign not found');
            return res.send(await detailPage(req, data));
        } catch (error) { return next(error); }
    });

    router.post('/admin/marketing/:id/queue', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await campaigns.queue({ campaignId: req.params.id, adminUserId: req.session.authUserId });
            return res.redirect(`/admin/marketing/${encodeURIComponent(req.params.id)}?message=${encodeURIComponent(`Queued ${result.queued} recipient(s), suppressed ${result.suppressed}.`)}`);
        } catch (error) {
            return res.redirect(`/admin/marketing/${encodeURIComponent(req.params.id)}?error=` + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/marketing/:id/schedule', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const scheduledFor = req.body.scheduledFor ? new Date(req.body.scheduledFor) : null;
            if (!scheduledFor || Number.isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) throw new Error('Choose a future date and time.');
            await campaigns.schedule(req.params.id, scheduledFor, req.session.authUserId);
            return res.redirect(`/admin/marketing/${encodeURIComponent(req.params.id)}?message=${encodeURIComponent('Campaign scheduled.')}`);
        } catch (error) {
            return res.redirect(`/admin/marketing/${encodeURIComponent(req.params.id)}?error=` + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/marketing/:id/unschedule', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await campaigns.unschedule(req.params.id, req.session.authUserId);
            return res.redirect(`/admin/marketing/${encodeURIComponent(req.params.id)}?message=${encodeURIComponent('Schedule cancelled.')}`);
        } catch (error) {
            return res.redirect(`/admin/marketing/${encodeURIComponent(req.params.id)}?error=` + encodeURIComponent(error.message));
        }
    });

    return router;
}

module.exports = { createAdminMarketingRouter };
