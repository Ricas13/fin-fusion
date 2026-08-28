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

async function selectableDiscounts() {
    const result = await query(`SELECT id,code,description FROM discount_codes WHERE active=TRUE AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY created_at DESC`);
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

function campaignRow(row) {
    return `<tr>
        <td><a href="/admin/marketing/${esc(row.id)}"><strong>${esc(row.name)}</strong></a><div class="muted">${esc(row.subject)}</div>${row.segment_name ? `<div class="subText">Saved segment: ${esc(row.segment_name)}</div>` : ''}</td>
        <td>${statusPill(row.status)}</td>
        <td>${esc(row.recipient_count)}</td>
        <td>${esc(row.queued_count)}</td>
        <td>${row.scheduled_for ? new Date(row.scheduled_for).toLocaleString('en-GB') : '—'}</td>
        <td>${new Date(row.created_at).toLocaleString('en-GB')}</td>
    </tr>`;
}

function segmentEditForm(req, segment, plans) {
    return `<details class="detailsBox"><summary>Edit</summary><form class="formPanel" method="post" action="/admin/marketing/segments/${esc(segment.id)}">${csrfInput(req)}
        <div class="formGroup"><label>Segment name</label><input class="input" name="name" required minlength="3" maxlength="160" value="${esc(segment.name)}"></div>
        ${audienceFields(plans, segment.audience_filters || {})}
        <div class="buttonRow"><button class="button secondary btn-sm">Save changes</button></div>
    </form></details>`;
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

async function listPage(req) {
    await runtimeSettings.ensureLoaded();
    const [rows, plans, discounts, segmentRows] = await Promise.all([campaigns.list(), selectablePlans(), selectableDiscounts(), marketingSegments.list()]);
    const savedSegments = await segmentsWithCounts(segmentRows);
    let requestedSegment = null;
    try { requestedSegment = marketingSegments.optionalUuid(req.query.segment, 'saved segment'); } catch (_) { requestedSegment = null; }

    const body = `${notice(req)}
        <div class="metrics">
            <div class="metric"><div class="metricLabel">Campaigns</div><div class="metricValue">${rows.length}</div></div>
            <div class="metric"><div class="metricLabel">Saved segments</div><div class="metricValue">${savedSegments.length}</div></div>
            <div class="metric"><div class="metricLabel">Queued</div><div class="metricValue">${rows.filter(r => r.status === 'queued').length}</div></div>
            <div class="metric"><div class="metricLabel">Scheduled</div><div class="metricValue">${rows.filter(r => r.status === 'scheduled').length}</div></div>
        </div>
        <section class="section" id="new-campaign">
            <div class="sectionHead"><h2>New campaign</h2><span class="muted">Only opted-in customers are eligible; consent is checked again when the campaign is queued.</span></div>
            <form class="formPanel" method="post" action="/admin/marketing">
                ${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Name</label><input class="input" name="name" required minlength="3" maxlength="160" placeholder="Autumn discount push"></div>
                    <div class="formGroup"><label>Discount code <span class="muted">(optional)</span></label><select class="input" name="discountCodeId"><option value="">None</option>${discounts.map(d => `<option value="${esc(d.id)}">${esc(d.code)}${d.description ? ` — ${esc(d.description)}` : ''}</option>`).join('')}</select></div>
                </div>
                <div class="formGroup"><label>Subject</label><input class="input" name="subject" required minlength="3" maxlength="300" placeholder="A discount just for you"></div>
                <div class="formGroup"><label>Message</label><textarea class="input" name="bodyText" required maxlength="100000" rows="6" placeholder="Write the message body. The discount code, if chosen, is appended automatically."></textarea></div>
                <div class="sectionHead"><div><h3>Audience</h3><div class="muted">Choose a saved segment or build a one-off audience. A selected saved segment overrides the one-off fields below and is copied into the campaign as a snapshot.</div></div></div>
                <div class="formGroup"><label>Saved segment</label><select class="input" name="segmentId"><option value="">Custom one-off audience</option>${savedSegments.map(segment => `<option value="${esc(segment.id)}" ${requestedSegment === String(segment.id) ? 'selected' : ''}>${esc(segment.name)} · ${segment.currentCount} opted in now</option>`).join('')}</select></div>
                ${audienceFields(plans)}
                <button class="button">Create draft campaign</button>
            </form>
        </section>
        <section class="section" id="segments">
            <div class="sectionHead"><div><h2>Saved segments</h2><div class="muted">Reusable dynamic audiences. Counts are live and aggregate-only; no recipient list is exposed here.</div></div><span class="pill">${savedSegments.length} saved</span></div>
            <form class="formPanel" method="post" action="/admin/marketing/segments">
                ${csrfInput(req)}
                <div class="formGroup"><label>Segment name</label><input class="input" name="name" required minlength="3" maxlength="160" placeholder="Lapsed paid users · 30 days"></div>
                ${audienceFields(plans)}
                <button class="button secondary">Save segment</button>
            </form>
            ${savedSegments.length ? `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Segment</th><th>Current opted-in audience</th><th>Filters</th><th>Actions</th></tr></thead><tbody>${savedSegments.map(segment => `<tr><td><strong>${esc(segment.name)}</strong><div class="subText">Updated ${new Date(segment.updated_at).toLocaleString('en-GB')}</div></td><td>${segment.currentCount}</td><td>${esc(audienceSummary(segment.audience_filters || {}, plans))}</td><td><div class="buttonRow"><a class="button secondary btn-sm" href="/admin/marketing?segment=${encodeURIComponent(segment.id)}#new-campaign">Use</a><form method="post" action="/admin/marketing/segments/${esc(segment.id)}/delete" data-confirm="Delete this saved segment? Existing campaigns keep their snapshotted audience filters.">${csrfInput(req)}<button class="button secondary btn-sm">Delete</button></form></div>${segmentEditForm(req, segment, plans)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No saved segments yet.</div>'}
        </section>
        <section class="section">
            <div class="sectionHead"><h2>Campaigns</h2><span class="muted">${rows.length} total</span></div>
            ${rows.length ? `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Campaign</th><th>Status</th><th>Recipients</th><th>Queued</th><th>Scheduled for</th><th>Created</th></tr></thead><tbody>${rows.map(campaignRow).join('')}</tbody></table></div>` : '<div class="empty">No campaigns yet.</div>'}
        </section>`;

    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'marketing',
        title: 'Marketing campaigns',
        subtitle: 'Discounts, offers and reusable customer segments',
        body
    });
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
        action: '<a class="button secondary" href="/admin/marketing">Back to campaigns</a>'
    });
}

function createAdminMarketingRouter() {
    const router = express.Router();
    router.use('/admin/marketing', gate, noStore);

    router.get('/admin/marketing', async (req, res, next) => {
        try { return res.send(await listPage(req)); } catch (error) { return next(error); }
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
            return res.redirect('/admin/marketing?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/marketing/segments', marketingWriteLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const created = await marketingSegments.save({ name: text(req.body.name, 160), audienceFilters: parseAudienceFilters(req.body), adminUserId: req.session.authUserId });
            return res.redirect(`/admin/marketing?segment=${encodeURIComponent(created.id)}&message=${encodeURIComponent('Saved segment created.')}#segments`);
        } catch (error) {
            return res.redirect('/admin/marketing?error=' + encodeURIComponent(error.message) + '#segments');
        }
    });

    router.post('/admin/marketing/segments/:id', marketingWriteLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await marketingSegments.save({ id: req.params.id, name: text(req.body.name, 160), audienceFilters: parseAudienceFilters(req.body), adminUserId: req.session.authUserId });
            return res.redirect('/admin/marketing?message=' + encodeURIComponent('Saved segment updated.') + '#segments');
        } catch (error) {
            return res.redirect('/admin/marketing?error=' + encodeURIComponent(error.message) + '#segments');
        }
    });

    router.post('/admin/marketing/segments/:id/delete', marketingWriteLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await marketingSegments.remove({ id: req.params.id, adminUserId: req.session.authUserId });
            return res.redirect('/admin/marketing?message=' + encodeURIComponent('Saved segment deleted. Existing campaigns kept their audience snapshot.') + '#segments');
        } catch (error) {
            return res.redirect('/admin/marketing?error=' + encodeURIComponent(error.message) + '#segments');
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
