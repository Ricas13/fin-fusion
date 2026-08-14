'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const auth = require('../auth/service');
const referrals = require('../referrals');
const { esc, layout } = require('./admin-html');
const { sendCsv } = require('./export');

function site() {
    return process.env.SITE_NAME || 'CAPTaINFiN';
}

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

function stepInput() {
    return `<div class="formGroup"><label>Authenticator / recovery code <span class="muted">(only needed if 2FA is enabled)</span></label><input class="input" name="code" autocomplete="one-time-code"></div>`;
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

async function requireStep(req) {
    return auth.verifySecondFactor(req.session.authUserId, req.body.code, req);
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
                <div class="formGroup"><label>Resolution note</label><input class="input" name="note" maxlength="200" placeholder="e.g. granted manually via reseller credit"></div>
                ${stepInput()}
                <button class="button secondary">Mark resolved</button>
            </form>
        </div>` : ''}
    </div>`;
}

async function page(req) {
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
            <div class="sectionHead"><h2>Reward settings</h2><span class="muted">Applied when a referred customer activates their first paid subscription</span></div>
            <form class="formPanel" method="post" action="/admin/referrals/settings">
                ${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Reward days <span class="muted">(added to referrer's active subscription)</span></label><input class="input" type="number" min="1" max="365" name="rewardDays" value="${esc(settings.rewardDays)}"></div>
                    <div class="formGroup"><label class="toggleRow"><input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''}><span>Referral program enabled</span></label></div>
                </div>
                ${stepInput()}
                <button class="button">Save settings</button>
            </form>
        </section>
        <section class="section">
            <div class="sectionHead"><h2>Referral activity</h2><span class="muted">${rows.length} shown, newest first</span></div>
            ${rows.length ? `<div class="serverGrid">${rows.map(row => redemptionCard(req, row)).join('')}</div>` : '<div class="empty">No referrals yet.</div>'}
        </section>`;

    return layout({
        siteName: site(),
        active: 'referrals',
        title: 'Referrals',
        subtitle: 'Referral codes, attribution and rewards',
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
            if (!(await requireStep(req))) throw new Error('verification');
            const rewardDays = Number.parseInt(req.body.rewardDays, 10);
            if (!Number.isFinite(rewardDays) || rewardDays < 1 || rewardDays > 365) throw new Error('Enter a reward of 1-365 days.');
            const enabled = req.body.enabled === 'on';
            await query(`
                INSERT INTO platform_settings(setting_key,setting_value,updated_by)
                VALUES('referral_program',$1::jsonb,$2)
                ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1::jsonb,updated_by=$2,updated_at=NOW()
            `, [JSON.stringify({ rewardDays, enabled }), req.session.authUserId]);
            await query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'admin.referrals.settings',NULL,NULL,$2::jsonb)
            `, [req.session.authUserId, JSON.stringify({ rewardDays, enabled })]);
            return res.redirect('/admin/referrals?message=' + encodeURIComponent('Referral settings saved.'));
        } catch (error) {
            return res.redirect('/admin/referrals?error=' + encodeURIComponent(error.message === 'verification' ? 'Verification failed.' : error.message));
        }
    });

    router.post('/admin/referrals/:id/resolve', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (!(await requireStep(req))) throw new Error('verification');
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
            return res.redirect('/admin/referrals?error=' + encodeURIComponent(error.message === 'verification' ? 'Verification failed.' : 'Could not resolve referral.'));
        }
    });

    return router;
}

module.exports = { createAdminReferralsRouter };
