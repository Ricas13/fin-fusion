'use strict';

const moneyFormat=require('./money-format');

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');
const { sendCsv } = require('./export');

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

function amountLabel(row) {
    if (row.discount_type === 'percent') return `${row.percent_off}% off`;
    return `${moneyFormat.formatMinor(row.fixed_off_minor,row.currency||'GBP')} off`;
}

function codeCard(req, row) {
    const usage = row.max_redemptions ? `${row.redemption_count} / ${row.max_redemptions}` : `${row.redemption_count} (unlimited)`;
    const expiry = row.expires_at ? new Date(row.expires_at).toLocaleDateString() : 'No expiry';
    return `<div class="serverCard">
        <div class="serverTop">
            <div><strong>${esc(row.code)}</strong><div class="subText">${esc(row.description || '')}</div></div>
            ${pill(row.active ? 'Active' : 'Disabled', row.active ? 'good' : 'bad')}
        </div>
        <div class="serverStats">
            <div><span class="metricMini">${esc(amountLabel(row))}</span><span class="subText">discount</span></div>
            <div><span class="metricMini">${esc(usage)}</span><span class="subText">redemptions</span></div>
            <div><span class="metricMini">${esc(row.per_customer_limit)}</span><span class="subText">per customer</span></div>
            <div><span class="metricMini">${esc(expiry)}</span><span class="subText">expires</span></div>
        </div>
        <div class="subText">Plans: ${Array.isArray(row.plan_codes) && row.plan_codes.length ? esc(row.plan_codes.join(', ')) : 'Any plan'}</div>
        <div class="formPanel">
            <form method="post" action="/admin/discounts/${esc(row.id)}/toggle">
                ${csrfInput(req)}
                <input type="hidden" name="active" value="${row.active ? 'false' : 'true'}">
                <button class="button ${row.active ? 'btn-danger' : 'btn-success'}">${row.active ? 'Disable code' : 'Enable code'}</button>
            </form>
        </div>
    </div>`;
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [rows,plans]=await Promise.all([listCodes(),selectablePlans()]);
    const active = rows.filter(r => r.active).length;
    const totalRedemptions = rows.reduce((sum, r) => sum + Number(r.redemption_count || 0), 0);

    const body = `${notice(req)}
        <div class="metrics">
            <div class="metric"><div class="metricLabel">Codes</div><div class="metricValue">${rows.length}</div></div>
            <div class="metric"><div class="metricLabel">Active</div><div class="metricValue">${active}</div></div>
            <div class="metric"><div class="metricLabel">Total redemptions</div><div class="metricValue">${totalRedemptions}</div></div>
        </div>
        <section class="section">
            <div class="sectionHead"><h2>Create discount code</h2><span class="muted">Applies at Stripe checkout for both modes, and at PayPal one-time checkout</span></div>
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
                <button class="button">Create discount code</button>
            </form>
        </section>
        <section class="section">
            <div class="sectionHead"><h2>Discount codes</h2><span class="muted">${rows.length} total</span></div>
            ${rows.length ? `<div class="serverGrid">${rows.map(row => codeCard(req, row)).join('')}</div>` : '<div class="empty">No discount codes yet.</div>'}
        </section>`;

    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'discounts',
        title: 'Discount codes',
        subtitle: 'Promo codes for direct checkout',
        body,
        action: '<a class="button secondary" href="/admin/discounts/export">Export CSV</a>'
    });
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
