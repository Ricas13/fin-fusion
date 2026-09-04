'use strict';

const moneyFormat=require('./money-format');

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');
const { sendCsv } = require('./export');
const marketing = require('./admin-marketing');
const campaigns = require('../marketing/campaigns');
const marketingSegments = require('../marketing/segments');

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

function integer(value, min, max, fallback = null) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function selectedValues(value){
    const values=Array.isArray(value)?value:[value];
    return [...new Set(values.map(item=>String(item||'').trim().toLowerCase()).filter(Boolean))].slice(0,200);
}

async function listCodes() {
    const result = await query(`SELECT * FROM discount_codes ORDER BY active DESC, created_at DESC`);
    return result.rows;
}

async function selectablePlans(){
    const result=await query(`SELECT code,name,service_type,billing_interval,currency,price_minor FROM plans WHERE active=TRUE AND archived_at IS NULL AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) ORDER BY sort_order,name`);
    return result.rows;
}

// Distinct from selectablePlans() above: campaign audience filters reference a
// plan by id (customer-filters.js's planId), while discount codes reference
// plans by their text code (plan_codes[]) -- two different join keys, two
// small local lookups, matching this file's existing no-shared-module pattern.
async function selectableCampaignPlans(){
    const result=await query(`SELECT id,code,name FROM plans WHERE archived_at IS NULL ORDER BY sort_order,name`);
    return result.rows;
}

async function selectableDiscountsForCampaign(){
    const result=await query(`SELECT id,code,description FROM discount_codes WHERE active=TRUE AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY created_at DESC`);
    return result.rows;
}

function amountLabel(row) {
    if (row.discount_type === 'percent') return `${row.percent_off}% off`;
    return `${moneyFormat.formatMinor(row.fixed_off_minor,row.currency||'GBP')} off`;
}

function campaignStatusPill(status) {
    const kind = status === 'queued' ? 'good' : status === 'scheduled' ? 'warn' : '';
    return pill(status, kind);
}

function discountRow(req, row, campaignsByCode) {
    const usage = row.max_redemptions ? `${row.redemption_count} / ${row.max_redemptions}` : `${row.redemption_count} (unlimited)`;
    const expiry = row.expires_at ? new Date(row.expires_at).toLocaleDateString('en-GB') : 'No expiry';
    const usedBy = campaignsByCode.get(String(row.id)) || [];
    return `<tr>
        <td data-label="Code"><div class="codeCell"><strong class="mono">${esc(row.code)}</strong>${row.description ? `<div class="subText">${esc(row.description)}</div>` : ''}</div></td>
        <td data-label="Value">${esc(amountLabel(row))}</td>
        <td data-label="Plans">${Array.isArray(row.plan_codes) && row.plan_codes.length ? esc(row.plan_codes.join(', ')) : 'Any plan'}</td>
        <td data-label="Redemptions">${esc(usage)}</td>
        <td data-label="Per customer">${esc(row.per_customer_limit)}</td>
        <td data-label="Expires">${esc(expiry)}</td>
        <td data-label="Status"><div class="metaStack">${pill(row.active ? 'Active' : 'Disabled', row.active ? 'good' : 'bad')}${usedBy.length ? `<a class="usedByLink" href="/admin/marketing/${esc(usedBy[0].id)}">Used in ${esc(usedBy[0].name)}${usedBy.length>1?` +${usedBy.length-1} more`:''}</a>` : ''}</div></td>
        <td data-label="">
            <form class="plainForm" method="post" action="/admin/discounts/${esc(row.id)}/toggle">
                ${csrfInput(req)}
                <input type="hidden" name="active" value="${row.active ? 'false' : 'true'}">
                <button class="button ${row.active ? 'btn-danger' : 'btn-success'} btn-sm">${row.active ? 'Disable' : 'Enable'}</button>
            </form>
        </td>
    </tr>`;
}

function campaignRow(row, discountById) {
    const discount = row.discount_code_id ? discountById.get(String(row.discount_code_id)) : null;
    return `<tr>
        <td data-label="Campaign"><a href="/admin/marketing/${esc(row.id)}"><strong>${esc(row.name)}</strong></a><div class="subText">${esc(row.subject)}</div>${row.segment_name ? `<div class="subText">Saved segment: ${esc(row.segment_name)}</div>` : ''}</td>
        <td data-label="Status">${campaignStatusPill(row.status)}</td>
        <td data-label="Code">${discount ? `<span class="mono">${esc(discount.code)}</span>` : '—'}</td>
        <td data-label="Recipients">${esc(row.recipient_count)}</td>
        <td data-label="Queued">${esc(row.queued_count)}</td>
        <td data-label="Scheduled for">${row.scheduled_for ? new Date(row.scheduled_for).toLocaleString('en-GB') : '—'}</td>
        <td data-label="Created">${new Date(row.created_at).toLocaleString('en-GB')}</td>
    </tr>`;
}

function segmentRow(req, segment, campaignPlans) {
    return `<tr>
        <td data-label="Segment"><strong>${esc(segment.name)}</strong><div class="subText">Updated ${new Date(segment.updated_at).toLocaleString('en-GB')}</div></td>
        <td data-label="Opted-in audience">${segment.currentCount}</td>
        <td data-label="Filters">${esc(marketing.audienceSummary(segment.audience_filters || {}, campaignPlans))}</td>
        <td data-label="">
            <div class="buttonRow">
                <a class="button secondary btn-sm" href="/admin/discounts?segment=${encodeURIComponent(segment.id)}#new-campaign">Use</a>
                <form class="plainForm" method="post" action="/admin/marketing/segments/${esc(segment.id)}/delete" data-confirm="Delete this saved segment? Existing campaigns keep their snapshotted audience filters.">${csrfInput(req)}<button class="button secondary btn-sm">Delete</button></form>
            </div>
            <details class="segEdit"><summary>Edit</summary><form class="formPanel" method="post" action="/admin/marketing/segments/${esc(segment.id)}">${csrfInput(req)}
                <div class="formGroup"><label>Segment name</label><input class="input" name="name" required minlength="3" maxlength="160" value="${esc(segment.name)}"></div>
                ${marketing.audienceFields(campaignPlans, segment.audience_filters || {})}
                <div class="buttonRow"><button class="button secondary btn-sm">Save changes</button></div>
            </form></details>
        </td>
    </tr>`;
}

async function discountCampaignMap(discountIds) {
    if (!discountIds.length) return new Map();
    const rows = (await query(`SELECT id,name,discount_code_id FROM marketing_campaigns WHERE discount_code_id=ANY($1::uuid[]) ORDER BY created_at DESC`, [discountIds])).rows;
    const map = new Map();
    for (const row of rows) {
        const key = String(row.discount_code_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [discountRows, plans, campaignPlans, campaignList, segmentRows, discountsForCampaign] = await Promise.all([
        listCodes(), selectablePlans(), selectableCampaignPlans(), campaigns.list(), marketingSegments.list(), selectableDiscountsForCampaign()
    ]);
    const [savedSegments, campaignsByCode] = await Promise.all([
        marketing.segmentsWithCounts(segmentRows),
        discountCampaignMap(discountRows.map(row => row.id))
    ]);
    const discountById = new Map(discountRows.map(row => [String(row.id), row]));
    let requestedSegment = null;
    try { requestedSegment = marketingSegments.optionalUuid(req.query.segment, 'saved segment'); } catch (_) { requestedSegment = null; }

    const active = discountRows.filter(r => r.active).length;
    const totalRedemptions = discountRows.reduce((sum, r) => sum + Number(r.redemption_count || 0), 0);
    const queuedCampaigns = campaignList.filter(r => r.status === 'queued').length;
    const scheduledCampaigns = campaignList.filter(r => r.status === 'scheduled').length;

    const body = `${notice(req)}
        <div class="metrics">
            <div class="metric"><div class="metricLabel">Active codes</div><div class="metricValue">${active}</div></div>
            <div class="metric"><div class="metricLabel">Total redemptions</div><div class="metricValue">${totalRedemptions}</div></div>
            <div class="metric"><div class="metricLabel">Campaigns</div><div class="metricValue">${campaignList.length}</div></div>
            <div class="metric"><div class="metricLabel">Queued</div><div class="metricValue">${queuedCampaigns}</div></div>
            <div class="metric"><div class="metricLabel">Scheduled</div><div class="metricValue">${scheduledCampaigns}</div></div>
        </div>

        <section class="section discountsHue">
            <div class="sectionHead"><h2>Discount codes</h2><span class="muted">Applies at Stripe checkout for both modes, and at PayPal one-time checkout</span></div>
            <form class="formPanel" method="post" action="/admin/discounts">
                ${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Code</label><input class="input" name="code" required maxlength="40" pattern="[A-Za-z0-9-]{3,40}" placeholder="SUMMER25"></div>
                    <div class="formGroup"><label>Type</label><select class="input" name="discountType"><option value="percent">Percent off</option><option value="fixed">Fixed amount off</option></select></div>
                    <div class="formGroup"><label>Percent off (1-100)</label><input class="input" type="number" name="percentOff" min="1" max="100"></div>
                    <div class="formGroup"><label>Fixed amount off</label><input class="input" type="number" step="0.01" min="0.01" name="fixedOff"></div>
                    <div class="formGroup"><label>Currency (for fixed)</label><select class="input" name="currency"><option value="GBP">GBP</option><option value="USD">USD</option><option value="EUR">EUR</option></select><div class="inlineHelp">Percentage discounts work naturally across currencies. Fixed discounts apply only in the selected currency.</div></div>
                    <div class="formGroup"><label>Eligible plans</label><select class="input" name="planCodes" multiple size="6">${plans.map(plan=>`<option value="${esc(plan.code)}">${esc(plan.name)} · ${esc(moneyFormat.formatMinor(plan.price_minor,plan.currency||'GBP'))} · ${esc(plan.billing_interval)}</option>`).join('')}</select><div class="inlineHelp">Leave all plans unselected to allow the code on any plan. Use Ctrl/Cmd-click to choose several.</div></div>
                    <div class="formGroup"><label>Max redemptions <span class="muted">(blank = unlimited)</span></label><input class="input" type="number" min="1" name="maxRedemptions"></div>
                    <div class="formGroup"><label>Per-customer limit</label><input class="input" type="number" min="1" max="1000" name="perCustomerLimit" value="1"></div>
                    <div class="formGroup"><label>Expires</label><input class="input" type="date" name="expiresAt"></div>
                </div>
                <div class="formGroup"><label>Description</label><input class="input" name="description" maxlength="200"></div>
                <button class="button primaryHue">+ Create discount code</button>
            </form>
            ${discountRows.length ? `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Code</th><th>Value</th><th>Plans</th><th>Redemptions</th><th>Per customer</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>${discountRows.map(row => discountRow(req, row, campaignsByCode)).join('')}</tbody></table></div>` : '<div class="empty">No discount codes yet.</div>'}
        </section>

        <section class="section campaignsHue" id="new-campaign">
            <div class="sectionHead"><h2>Email campaigns <span class="newTag">Reaches customers who opted in</span></h2><span class="muted">Sends through email, and Discord/Telegram/WhatsApp where a customer has opted those in too. Consent is checked again the moment a campaign is queued.</span></div>
            <form class="formPanel" method="post" action="/admin/marketing">
                ${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Name</label><input class="input" name="name" required minlength="3" maxlength="160" placeholder="Autumn discount push"></div>
                    <div class="formGroup"><label>Discount code <span class="muted">(optional)</span></label><select class="input" name="discountCodeId"><option value="">None</option>${discountsForCampaign.map(d => `<option value="${esc(d.id)}">${esc(d.code)}${d.description ? ` — ${esc(d.description)}` : ''}</option>`).join('')}</select></div>
                </div>
                <div class="formGroup"><label>Subject</label><input class="input" name="subject" required minlength="3" maxlength="300" placeholder="A discount just for you"></div>
                <div class="formGroup"><label>Message</label><textarea class="input" name="bodyText" required maxlength="100000" rows="6" placeholder="Write the message body. The discount code, if chosen, is appended automatically."></textarea></div>
                <div class="sectionHead innerHead"><div><h3>Audience</h3><div class="muted">Choose a saved segment or build a one-off audience. A selected saved segment overrides the one-off fields below and is copied into the campaign as a snapshot.</div></div></div>
                <div class="formGroup"><label>Saved segment</label><select class="input" name="segmentId"><option value="">Custom one-off audience</option>${savedSegments.map(segment => `<option value="${esc(segment.id)}" ${requestedSegment === String(segment.id) ? 'selected' : ''}>${esc(segment.name)} · ${segment.currentCount} opted in now</option>`).join('')}</select></div>
                ${marketing.audienceFields(campaignPlans)}
                <button class="button primaryHue">Create draft campaign</button>
            </form>

            <div class="sectionHead innerHead" id="segments"><div><h3>Saved segments</h3><div class="muted">Reusable dynamic audiences. Counts are live and aggregate-only; no recipient list is exposed here.</div></div>${pill(`${savedSegments.length} saved`)}</div>
            <form class="formPanel" method="post" action="/admin/marketing/segments">
                ${csrfInput(req)}
                <div class="formGroup"><label>Segment name</label><input class="input" name="name" required minlength="3" maxlength="160" placeholder="Lapsed paid users · 30 days"></div>
                ${marketing.audienceFields(campaignPlans)}
                <button class="button secondary">Save segment</button>
            </form>
            ${savedSegments.length ? `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Segment</th><th>Opted-in audience</th><th>Filters</th><th></th></tr></thead><tbody>${savedSegments.map(segment => segmentRow(req, segment, campaignPlans)).join('')}</tbody></table></div>` : '<div class="empty">No saved segments yet.</div>'}

            <div class="sectionHead innerHead"><h3>Campaigns</h3><span class="muted">${campaignList.length} total</span></div>
            ${campaignList.length ? `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Campaign</th><th>Status</th><th>Code</th><th>Recipients</th><th>Queued</th><th>Scheduled for</th><th>Created</th></tr></thead><tbody>${campaignList.map(row => campaignRow(row, discountById)).join('')}</tbody></table></div>` : '<div class="empty">No campaigns yet.</div>'}
        </section>`;

    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'discounts',
        title: 'Discounts & campaigns',
        subtitle: 'Promo codes for checkout, and the emails that tell customers about them',
        body: styles() + body,
        action: '<a class="button secondary" href="/admin/discounts/export">Export CSV</a>'
    });
}

function styles() {
    return `<style>
.discountsPage .codeCell{display:grid;gap:2px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.metaStack{display:grid;gap:5px}
.usedByLink{font-size:10.5px;color:var(--hue);text-decoration:none}
.usedByLink:hover{text-decoration:underline}
.newTag{font-size:9.5px;font-weight:800;letter-spacing:.04em;text-transform:none;color:var(--hue);background:color-mix(in srgb,var(--hue) 14%,transparent);border:1px solid color-mix(in srgb,var(--hue) 30%,transparent);padding:2px 8px;border-radius:999px;margin-left:8px;vertical-align:middle}
.innerHead{margin-top:22px;padding-top:16px;border-top:1px solid var(--border-soft)}
.button.primaryHue{background:var(--hue);border-color:var(--hue);color:#1a1102}
.button.primaryHue:hover{filter:brightness(1.08)}
.section.discountsHue .sectionHead,.section.campaignsHue .sectionHead{box-shadow:inset 3px 0 0 color-mix(in srgb,var(--hue) 55%,transparent)}
.segEdit{margin-top:8px}
.segEdit summary{cursor:pointer;color:var(--muted2);font-size:11px;font-weight:700;list-style:none}
.segEdit summary::-webkit-details-marker{display:none}
.segEdit[open] summary{color:var(--hue)}
@media(max-width:640px){.buttonRow{flex-direction:column}.buttonRow .button{width:100%}}
</style>`;
}

function createAdminDiscountsRouter() {
    const router = express.Router();
    router.use('/admin/discounts', gate, noStore);

    router.get('/admin/discounts', async (req, res, next) => {
        try { return res.send(await page(req)); } catch (error) { return next(error); }
    });

    router.get('/admin/discounts/export', async (req, res, next) => {
        try {
            const rows = await listCodes();
            return sendCsv(res, 'discount-codes.csv', [
                { key: 'code', label: 'Code' },
                { key: 'description', label: 'Description' },
                { key: 'discount_type', label: 'Type' },
                { label: 'Amount', value: r => amountLabel(r) },
                { key: 'plan_codes', label: 'Plan codes', value: r => Array.isArray(r.plan_codes) ? r.plan_codes.join(' ') : 'any' },
                { key: 'redemption_count', label: 'Redemptions' },
                { key: 'max_redemptions', label: 'Max redemptions' },
                { key: 'per_customer_limit', label: 'Per-customer limit' },
                { key: 'active', label: 'Active' },
                { key: 'expires_at', label: 'Expires at' },
                { key: 'created_at', label: 'Created at' }
            ], rows);
        } catch (error) { return next(error); }
    });

    router.post('/admin/discounts', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const code = text(req.body.code, 40).toUpperCase();
            if (!/^[A-Z0-9-]{3,40}$/.test(code)) throw new Error('Enter a valid code (letters, numbers, dashes).');
            const discountType = req.body.discountType === 'fixed' ? 'fixed' : 'percent';
            const description = text(req.body.description, 200);
            const requestedPlans=selectedValues(req.body.planCodes);
            let planCodes=[];
            if(requestedPlans.length){
                const valid=await query(`SELECT code FROM plans WHERE code=ANY($1::text[])`,[requestedPlans]);
                const allowed=new Set(valid.rows.map(row=>String(row.code).toLowerCase()));
                planCodes=requestedPlans.filter(code=>allowed.has(code));
                if(planCodes.length!==requestedPlans.length)throw new Error('One or more selected plans no longer exist. Refresh and try again.');
            }
            const maxRedemptions = integer(req.body.maxRedemptions, 1, 1000000, null);
            const perCustomerLimit = integer(req.body.perCustomerLimit, 1, 1000, 1);
            const expiresAt = req.body.expiresAt ? new Date(`${req.body.expiresAt}T23:59:59Z`) : null;

            let percentOff = null, fixedOffMinor = null, currency = null;
            if (discountType === 'percent') {
                percentOff = integer(req.body.percentOff, 1, 100, null);
                if (!percentOff) throw new Error('Enter a percent off between 1 and 100.');
            } else {
                const value = Number(req.body.fixedOff);
                if (!Number.isFinite(value) || value <= 0 || value > 100000) throw new Error('Enter a valid fixed amount.');
                fixedOffMinor = Math.round(value * 100);
                currency = text(req.body.currency, 3).toUpperCase() || 'GBP';
                if (!['GBP','USD','EUR'].includes(currency)) throw new Error('Choose GBP, USD or EUR for a fixed discount.');
            }

            await transaction(async client => {
                const created = await client.query(`
                    INSERT INTO discount_codes(
                        code,description,discount_type,percent_off,fixed_off_minor,currency,
                        plan_codes,max_redemptions,per_customer_limit,expires_at,created_by
                    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    RETURNING id
                `, [code, description, discountType, percentOff, fixedOffMinor, currency,
                    planCodes.length ? planCodes : null, maxRedemptions, perCustomerLimit, expiresAt, req.session.authUserId]);
                await client.query(`
                    INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                    VALUES($1,'admin.discount.create','discount_code',$2,$3::jsonb)
                `, [req.session.authUserId, created.rows[0].id, JSON.stringify({ code, discountType, planCodes })]);
            });
            return res.redirect('/admin/discounts?message=' + encodeURIComponent('Discount code created.'));
        } catch (error) {
            console.error('Discount create failed:', error.message);
            const msg = error.code === '23505' ? 'That code already exists.' : error.message;
            return res.redirect('/admin/discounts?error=' + encodeURIComponent(msg));
        }
    });

    router.post('/admin/discounts/:id/toggle', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const active = String(req.body.active) === 'true';
            const updated = await query('UPDATE discount_codes SET active=$2,updated_at=NOW() WHERE id=$1 RETURNING code', [req.params.id, active]);
            if (!updated.rowCount) throw new Error('missing');
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.discount.toggle','discount_code',$2,$3::jsonb)`, [req.session.authUserId, req.params.id, JSON.stringify({ active })]);
            return res.redirect('/admin/discounts?message=' + encodeURIComponent(active ? 'Code enabled.' : 'Code disabled.'));
        } catch (error) {
            return res.redirect('/admin/discounts?error=' + encodeURIComponent('Discount code could not be updated.'));
        }
    });

    return router;
}

module.exports = { createAdminDiscountsRouter, selectablePlans };
