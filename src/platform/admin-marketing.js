'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');
const campaigns = require('../marketing/campaigns');
const marketingSegments = require('../marketing/segments');
const customerFilters = require('../platform/customer-filters');
const routeRateLimit = require('../security/route-rate-limit');

const marketingWriteLimit = routeRateLimit.middleware({ scope: 'admin-marketing-write', max: 30, windowSeconds: 60, reason: 'admin_marketing_write' });

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

function parseAudienceFilters(body) {
    return marketingSegments.normalizeFilters({
        service: body.service,
        planId: body.planId,
        status: body.status,
        priceType: body.priceType,
        billingInterval: body.billingInterval,
        accountAgeDays: body.accountAgeDays,
        lapsedDays: body.lapsedDays,
        expiresWithinDays: body.expiresWithinDays,
        inactivePlaybackDays: body.inactivePlaybackDays,
        isFreeTier: body.isFreeTier
    });
}

function audienceSummary(filters, plans = []) {
    const parts = [];
    const plan = filters.planId ? plans.find(row => String(row.id) === String(filters.planId)) : null;
    if (filters.service) parts.push(filters.service === 'jellyfin' ? 'Jellyfin' : 'Stremio');
    if (filters.planId) parts.push(plan ? `plan ${plan.name}` : 'specific plan');
    if (filters.status) parts.push(filters.status === 'none' ? 'no subscription' : `status ${filters.status}`);
    if (filters.priceType) parts.push(filters.priceType === 'free' ? 'free' : 'paid');
    else if (filters.isFreeTier) parts.push('free tier');
    if (filters.billingInterval) parts.push(`billing ${filters.billingInterval.replace('_', ' ')}`);
    if (filters.accountAgeDays !== undefined) parts.push(`account ≥ ${filters.accountAgeDays}d`);
    if (filters.lapsedDays !== undefined) parts.push(`lapsed ≥ ${filters.lapsedDays}d`);
    if (filters.expiresWithinDays !== undefined) parts.push(`expires ≤ ${filters.expiresWithinDays}d`);
    if (filters.inactivePlaybackDays !== undefined) parts.push(`inactive ≥ ${filters.inactivePlaybackDays}d`);
    return parts.length ? parts.join(' · ') : 'All customers';
}

function audienceFields(plans, filters = {}) {
    const value = key => filters[key] === undefined || filters[key] === null ? '' : filters[key];
    return `<div class="formGrid">
        <div class="formGroup"><label>Service</label><select class="input" name="service"><option value="">Any service</option>${customerFilters.SERVICE_VALUES.map(service => `<option value="${esc(service)}" ${value('service') === service ? 'selected' : ''}>${esc(service === 'jellyfin' ? 'Jellyfin' : 'Stremio')}</option>`).join('')}</select></div>
        <div class="formGroup"><label>Plan</label><select class="input" name="planId"><option value="">Any plan</option>${plans.map(p => `<option value="${esc(p.id)}" ${String(value('planId')) === String(p.id) ? 'selected' : ''}>${esc(p.name)}${p.code ? ` · ${esc(p.code)}` : ''}</option>`).join('')}</select></div>
        <div class="formGroup"><label>Subscription status</label><select class="input" name="status"><option value="">Any status</option>${customerFilters.STATUS_VALUES.map(s => `<option value="${esc(s)}" ${value('status') === s ? 'selected' : ''}>${esc(s.replace('_', ' '))}</option>`).join('')}<option value="none" ${value('status') === 'none' ? 'selected' : ''}>No subscription</option></select></div>
        <div class="formGroup"><label>Price type</label><select class="input" name="priceType"><option value="">Free or paid</option><option value="free" ${value('priceType') === 'free' || filters.isFreeTier ? 'selected' : ''}>Free</option><option value="paid" ${value('priceType') === 'paid' ? 'selected' : ''}>Paid</option></select></div>
        <div class="formGroup"><label>Billing interval</label><select class="input" name="billingInterval"><option value="">Any interval</option>${customerFilters.BILLING_INTERVALS.map(interval => `<option value="${esc(interval)}" ${value('billingInterval') === interval ? 'selected' : ''}>${esc(interval.replace('_', ' '))}</option>`).join('')}</select></div>
        <div class="formGroup"><label>Account age at least <span class="muted">days</span></label><input class="input" type="number" min="0" max="3650" name="accountAgeDays" value="${esc(value('accountAgeDays'))}" placeholder="e.g. 30"></div>
        <div class="formGroup"><label>Lapsed for at least <span class="muted">days</span></label><input class="input" type="number" min="0" max="3650" name="lapsedDays" value="${esc(value('lapsedDays'))}" placeholder="e.g. 14"></div>
        <div class="formGroup"><label>Expires within <span class="muted">days</span></label><input class="input" type="number" min="1" max="365" name="expiresWithinDays" value="${esc(value('expiresWithinDays'))}" placeholder="e.g. 7"></div>
        <div class="formGroup"><label>No playback for <span class="muted">days</span></label><input class="input" type="number" min="1" max="3650" name="inactivePlaybackDays" value="${esc(value('inactivePlaybackDays'))}" placeholder="e.g. 30"></div>
    </div>`;
}

function statusPill(status) {
    const kind = status === 'sent' || status === 'queued' ? 'good' : status === 'cancelled' ? 'bad' : status === 'scheduled' ? 'accent' : '';
    return pill(status, kind);
}

async function segmentsWithCounts(rows) {
    if (!rows.length) return [];
    const output = new Array(rows.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= rows.length) break;
            const row = rows[index];
            output[index] = { ...row, currentCount: (await campaigns.preview(row.audience_filters || {})).count };
        }
    });
    await Promise.all(workers);
    return output;
}

async function detailPage(req, data) {
    await runtimeSettings.ensureLoaded();
    const { campaign, recipients, deliveries, discountCode } = data;
    const canEdit = ['draft', 'scheduled', 'queued'].includes(campaign.status);
    const [preview, plans] = await Promise.all([canEdit ? campaigns.preview(campaign.audience_filters || {}) : Promise.resolve({ count: recipients.length }), selectablePlans()]);

    const deliveryCounts = deliveries.reduce((acc, d) => { acc[d.channel] = acc[d.channel] || { queued: 0, suppressed: 0, failed: 0 }; if (acc[d.channel][d.status] !== undefined) acc[d.channel][d.status] += 1; return acc; }, {});

    const scheduleForm = campaign.status === 'draft'
        ? `<form class="formPanel" method="post" action="/admin/marketing/${esc(campaign.id)}/schedule">${csrfInput(req)}<div class="formGroup"><label>Schedule for</label><input class="input" type="datetime-local" name="scheduledFor" required></div><button class="button secondary">Schedule</button></form>`
        : campaign.status === 'scheduled'
            ? `<div class="notice warn">Scheduled for ${new Date(campaign.scheduled_for).toLocaleString('en-GB')}.</div><form method="post" action="/admin/marketing/${esc(campaign.id)}/unschedule">${csrfInput(req)}<button class="button secondary">Cancel schedule</button></form>`
            : '';

    const queueForm = ['draft', 'scheduled', 'queued'].includes(campaign.status)
        ? `<form method="post" action="/admin/marketing/${esc(campaign.id)}/queue" data-confirm="Send this campaign to its current eligible audience now?">${csrfInput(req)}<button class="button">Queue now</button></form>`
        : '';

    const body = `${notice(req)}
        <section class="section">
            <div class="sectionHead"><div><h2>${esc(campaign.name)}</h2><div class="muted">${esc(campaign.subject)}</div></div>${statusPill(campaign.status)}</div>
            <div class="formPanel"><div class="subText">Discount code: ${discountCode ? esc(discountCode.code) : 'None'}</div><div class="subText">Audience source: ${campaign.segment_name ? `Saved segment ${esc(campaign.segment_name)} · snapshotted at campaign creation` : 'Custom one-off audience'}</div><div class="subText">Audience: ${esc(audienceSummary(campaign.audience_filters || {}, plans))}</div><div class="subText">Message:</div><p>${esc(campaign.body_text)}</p></div>
            ${canEdit ? `<div class="notice">${preview.count} customer(s) are currently eligible and opted in for this snapshotted audience.</div>` : ''}
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
        action: '<a class="button secondary" href="/admin/discounts">Back to campaigns</a>'
    });
}

function createAdminMarketingRouter() {
    const router = express.Router();
    router.use('/admin/marketing', gate, noStore);

    // The list/create UI moved onto the Discounts page so codes and the
    // campaigns that use them live in one workspace; this route now only
    // preserves old links and the campaign detail/segment mutation routes
    // below, which stay here.
    router.get('/admin/marketing', (req, res) => {
        const qs = new URLSearchParams(req.query).toString();
        return res.redirect('/admin/discounts' + (qs ? `?${qs}` : ''));
    });

    router.post('/admin/marketing', marketingWriteLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const audienceFilters = parseAudienceFilters(req.body);
            const created = await campaigns.create({
                name: text(req.body.name, 160),
                subject: text(req.body.subject, 300),
                bodyText: text(req.body.bodyText, 100000),
                discountCodeId: req.body.discountCodeId || null,
                segmentId: req.body.segmentId || null,
                audienceFilters,
                adminUserId: req.session.authUserId
            });
            return res.redirect(`/admin/marketing/${encodeURIComponent(created.id)}?message=${encodeURIComponent('Campaign created as a draft.')}`);
        } catch (error) {
            return res.redirect('/admin/discounts?error=' + encodeURIComponent(error.message) + '#new-campaign');
        }
    });

    router.post('/admin/marketing/segments', marketingWriteLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const created = await marketingSegments.save({ name: text(req.body.name, 160), audienceFilters: parseAudienceFilters(req.body), adminUserId: req.session.authUserId });
            return res.redirect(`/admin/discounts?segment=${encodeURIComponent(created.id)}&message=${encodeURIComponent('Saved segment created.')}#segments`);
        } catch (error) {
            return res.redirect('/admin/discounts?error=' + encodeURIComponent(error.message) + '#segments');
        }
    });

    router.post('/admin/marketing/segments/:id', marketingWriteLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await marketingSegments.save({ id: req.params.id, name: text(req.body.name, 160), audienceFilters: parseAudienceFilters(req.body), adminUserId: req.session.authUserId });
            return res.redirect('/admin/discounts?message=' + encodeURIComponent('Saved segment updated.') + '#segments');
        } catch (error) {
            return res.redirect('/admin/discounts?error=' + encodeURIComponent(error.message) + '#segments');
        }
    });

    router.post('/admin/marketing/segments/:id/delete', marketingWriteLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await marketingSegments.remove({ id: req.params.id, adminUserId: req.session.authUserId });
            return res.redirect('/admin/discounts?message=' + encodeURIComponent('Saved segment deleted. Existing campaigns kept their audience snapshot.') + '#segments');
        } catch (error) {
            return res.redirect('/admin/discounts?error=' + encodeURIComponent(error.message) + '#segments');
        }
    });

    router.get('/admin/marketing/:id', async (req, res, next) => {
        try {
            const data = await campaigns.get(req.params.id);
            if (!data) return res.status(404).send('Campaign not found');
            return res.send(await detailPage(req, data));
        } catch (error) { return next(error); }
    });

    router.post('/admin/marketing/:id/queue', marketingWriteLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await campaigns.queue({ campaignId: req.params.id, adminUserId: req.session.authUserId });
            return res.redirect(`/admin/marketing/${encodeURIComponent(req.params.id)}?message=${encodeURIComponent(`Queued ${result.queued} recipient(s), suppressed ${result.suppressed}.`)}`);
        } catch (error) {
            return res.redirect(`/admin/marketing/${encodeURIComponent(req.params.id)}?error=` + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/marketing/:id/schedule', marketingWriteLimit, async (req, res) => {
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

    router.post('/admin/marketing/:id/unschedule', marketingWriteLimit, async (req, res) => {
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

module.exports = { createAdminMarketingRouter, parseAudienceFilters, audienceSummary, audienceFields, segmentsWithCounts };
