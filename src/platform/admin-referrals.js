'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const referrals = require('../referrals');
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

function date(v) {
    return v ? new Date(v).toLocaleString() : 'never';
}

async function listRedemptions() {
    const result = await query(`
        SELECT rr.id,rr.status,rr.reward_note,rr.rewarded_at,rr.created_at,rc.code AS referral_code,
               referrer.display_name AS referrer_name,referrer.email AS referrer_email,
               referred.display_name AS referred_name,referred.email AS referred_email
        FROM referral_redemptions rr
        JOIN referral_codes rc ON rc.id=rr.referral_code_id
        JOIN customers referrer ON referrer.id=rc.customer_id
        JOIN customers referred ON referred.id=rr.referred_customer_id
        ORDER BY rr.created_at DESC
        LIMIT 500
    `);
    return result.rows;
}

function statusPill(status) {
    if (status === 'rewarded') return pill('Rewarded', 'good');
    if (status === 'unfulfilled') return pill('Unfulfilled', 'warn');
    return pill('Pending', 'accent');
}

function redemptionCard(req, row) {
    return `<div class="serverCard">
        <div class="serverTop">
            <div><strong>${esc(row.referrer_name || row.referrer_email || 'Referrer')}</strong><div class="subText">referred ${esc(row.referred_name || row.referred_email || 'a customer')}</div></div>
            ${statusPill(row.status)}
        </div>
        <div class="subText">Code ${esc(row.referral_code)} · ${esc(date(row.created_at))}</div>
        ${row.reward_note ? `<div class="subText">${esc(row.reward_note)}</div>` : ''}
        ${row.status === 'unfulfilled' ? `<div class="formPanel">
            <form method="post" action="/admin/referrals/${esc(row.id)}/resolve">
                ${csrfInput(req)}
                <div class="formGroup"><label>Resolution note</label><input class="input" name="note" maxlength="200" placeholder="e.g. reviewed and resolved manually"></div>
                <button class="button secondary">Mark resolved</button>
            </form>
        </div>` : ''}
    </div>`;
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [rows, settings] = await Promise.all([listRedemptions(), referrals.loadSettings()]);
    const rewarded = rows.filter(r => r.status === 'rewarded').length;
    const unfulfilled = rows.filter(r => r.status === 'unfulfilled').length;

    const body = `${notice(req)}
        <div class="metrics">
            <div class="metric"><div class="metricLabel">Referrals</div><div class="metricValue">${rows.length}</div></div>
            <div class="metric"><div class="metricLabel">Rewarded</div><div class="metricValue">${rewarded}</div></div>
            <div class="metric"><div class="metricLabel">Needs attention</div><div class="metricValue">${unfulfilled}</div></div>
        </div>
        <section class="section">
            <div class="sectionHead"><h2>Reward settings</h2><span class="muted">Only a genuine positive-value Stripe/PayPal activation qualifies; same email/payment identities are rejected.</span></div>
            <form class="formPanel" method="post" action="/admin/referrals/settings">
                ${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Reward days <span class="muted">(added to referrer's active subscription)</span></label><input class="input" type="number" min="1" max="365" name="rewardDays" value="${esc(settings.rewardDays)}"></div>
                    <div class="formGroup"><label>Qualification delay (days)</label><input class="input" type="number" min="0" max="90" name="qualificationDelayDays" value="${esc(settings.qualificationDelayDays)}"><div class="inlineHelp">Minimum age of the referred paid subscription before the reward can be granted.</div></div>
                    <div class="formGroup"><label>Refund/dispute window (days)</label><input class="input" type="number" min="0" max="90" name="refundWindowDays" value="${esc(settings.refundWindowDays)}"><div class="inlineHelp">Reward waits at least this long and remains pending while a payment-risk hold is open.</div></div>
                    <div class="formGroup"><label class="toggleRow"><input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''}><span>Referral program enabled</span></label></div>
                </div>
                <button class="button">Save settings</button>
            </form>
        </section>
        <section class="section">
            <div class="sectionHead"><h2>Referral activity</h2><span class="muted">${rows.length} shown, newest first</span></div>
            ${rows.length ? `<div class="serverGrid">${rows.map(row => redemptionCard(req, row)).join('')}</div>` : '<div class="empty">No referrals yet.</div>'}
        </section>`;

    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'referrals',
        title: 'Referrals',
        subtitle: 'Referral codes, attribution and delayed paid-event rewards',
        body,
        action: '<a class="button secondary" href="/admin/referrals/export">Export CSV</a>'
    });
}

function createAdminReferralsRouter() {
    const router = express.Router();
    router.use('/admin/referrals', gate, noStore);

    router.get('/admin/referrals', async (req, res, next) => {
        try {
            return res.send(await page(req));
        } catch (error) {
            return next(error);
        }
    });

    router.get('/admin/referrals/export', async (req, res, next) => {
        try {
            const rows = await listRedemptions();
            return sendCsv(res, 'referrals.csv', [
                { key: 'referral_code', label: 'Referral code' },
                { key: 'referrer_name', label: 'Referrer' },
                { key: 'referrer_email', label: 'Referrer email' },
                { key: 'referred_name', label: 'Referred customer' },
                { key: 'referred_email', label: 'Referred email' },
                { key: 'status', label: 'Status' },
                { key: 'reward_note', label: 'Note' },
                { key: 'rewarded_at', label: 'Rewarded at' },
                { key: 'created_at', label: 'Created at' }
            ], rows);
        } catch (error) {
            return next(error);
        }
    });

    router.post('/admin/referrals/settings', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const rewardDays = Number.parseInt(req.body.rewardDays, 10);
            const qualificationDelayDays = Number.parseInt(req.body.qualificationDelayDays, 10);
            const refundWindowDays = Number.parseInt(req.body.refundWindowDays, 10);
            if (!Number.isFinite(rewardDays) || rewardDays < 1 || rewardDays > 365) throw new Error('Enter a reward of 1-365 days.');
            if (!Number.isFinite(qualificationDelayDays) || qualificationDelayDays < 0 || qualificationDelayDays > 90) throw new Error('Enter a qualification delay of 0-90 days.');
            if (!Number.isFinite(refundWindowDays) || refundWindowDays < 0 || refundWindowDays > 90) throw new Error('Enter a refund/dispute window of 0-90 days.');
            const enabled = req.body.enabled === 'on';
            const value = { rewardDays, qualificationDelayDays, refundWindowDays, enabled };
            await query(`
                INSERT INTO platform_settings(setting_key,setting_value,updated_by)
                VALUES('referral_program',$1::jsonb,$2)
                ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1::jsonb,updated_by=$2,updated_at=NOW()
            `, [JSON.stringify(value), req.session.authUserId]);
            await query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'admin.referrals.settings',NULL,NULL,$2::jsonb)
            `, [req.session.authUserId, JSON.stringify(value)]);
            return res.redirect('/admin/referrals?message=' + encodeURIComponent('Referral settings saved.'));
        } catch (error) {
            return res.redirect('/admin/referrals?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/referrals/:id/resolve', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const note = String(req.body.note || '').trim().slice(0, 200) || 'Resolved manually by admin';
            const updated = await query(`
                UPDATE referral_redemptions SET status='rewarded',rewarded_at=NOW(),reward_note=$2
                WHERE id=$1 AND status='unfulfilled' RETURNING id
            `, [req.params.id, note]);
            if (!updated.rowCount) throw new Error('missing');
            await query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'admin.referrals.resolve','referral_redemption',$2,$3::jsonb)
            `, [req.session.authUserId, req.params.id, JSON.stringify({ note })]);
            return res.redirect('/admin/referrals?message=' + encodeURIComponent('Referral marked resolved.'));
        } catch (error) {
            return res.redirect('/admin/referrals?error=' + encodeURIComponent('Could not resolve referral.'));
        }
    });

    return router;
}

module.exports = { createAdminReferralsRouter };
