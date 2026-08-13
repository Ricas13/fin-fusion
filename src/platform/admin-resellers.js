'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const auth = require('../auth/service');
const { esc, layout } = require('./admin-html');

function site() {
    return process.env.SITE_NAME || 'CAPTaINFiN';
}

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

function text(value, max = 500) {
    return String(value || '').trim().slice(0, max);
}

function integer(value, min, max, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function csrfInput(req) {
    return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;
}

function stepInput() {
    return `<div class="formGroup"><label>Authenticator / recovery code <span class="muted">(only needed if 2FA is enabled)</span></label><input class="input" name="code" autocomplete="one-time-code"></div>`;
}

function notice(value, kind = '') {
    return value ? `<div class="notice ${kind}">${esc(value)}</div>` : '';
}

function redirect(res, key, message) {
    return res.redirect('/admin/reseller-management?' + key + '=' + encodeURIComponent(message));
}

async function requireStep(req) {
    return auth.verifySecondFactor(req.session.authUserId, req.body.code, req);
}

async function loadDefaults() {
    const result = await query("SELECT setting_value FROM platform_settings WHERE setting_key='reseller_defaults'");
    const value = result.rows[0]?.setting_value || {};
    return {
        credits: integer(value.credits, 0, 100000, 0),
        trialCredits: integer(value.trialCredits, 0, 20, 0)
    };
}

async function listResellers() {
    const result = await query(`
        SELECT r.id,r.user_id,r.credits,r.trial_credits,r.note,r.created_at,
               u.username,u.email,u.active,u.last_login_at,
               COUNT(c.id)::int AS customers
        FROM resellers r
        JOIN app_users u ON u.id=r.user_id
        LEFT JOIN customers c ON c.reseller_id=r.id
        GROUP BY r.id,u.id
        ORDER BY u.username
    `);
    return result.rows;
}

function resellerCard(req, row) {
    const statusClass = row.active ? 'good' : 'bad';
    const statusText = row.active ? 'Active' : 'Disabled';
    return `<div class="serverCard">
        <div class="serverTop">
            <div><strong>${esc(row.username)}</strong><div class="subText">${esc(row.email || 'No email')}</div></div>
            <span class="pill ${statusClass}">${statusText}</span>
        </div>
        <div class="serverStats">
            <div><span class="metricMini">${esc(row.credits)}</span><span class="subText">regular credits</span></div>
            <div><span class="metricMini">${esc(row.trial_credits)}</span><span class="subText">trial credits</span></div>
            <div><span class="metricMini">${esc(row.customers)}</span><span class="subText">customers</span></div>
            <div><span class="metricMini">${esc(row.last_login_at ? new Date(row.last_login_at).toLocaleDateString() : 'Never')}</span><span class="subText">last login</span></div>
        </div>
        <div class="formPanel">
            <form method="post" action="/admin/reseller-management/${esc(row.id)}/credits">
                ${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Regular credit adjustment</label><input class="input" type="number" name="regularDelta" min="-100000" max="100000" value="0"></div>
                    <div class="formGroup"><label>Trial credit adjustment</label><input class="input" type="number" name="trialDelta" min="-20" max="20" value="0"></div>
                </div>
                <div class="formGroup"><label>Reason</label><input class="input" name="note" maxlength="200" placeholder="Optional audit note"></div>
                ${stepInput()}
                <button class="button secondary">Apply credit adjustment</button>
            </form>
            <hr class="divider">
            <form method="post" action="/admin/reseller-management/${esc(row.id)}/status">
                ${csrfInput(req)}
                <input type="hidden" name="active" value="${row.active ? 'false' : 'true'}">
                ${stepInput()}
                <button class="button ${row.active ? 'btn-danger' : 'btn-success'}">${row.active ? 'Disable reseller' : 'Enable reseller'}</button>
            </form>
        </div>
    </div>`;
}

async function page(req) {
    const [rows, defaults] = await Promise.all([listResellers(), loadDefaults()]);
    const totalCredits = rows.reduce((sum, row) => sum + Number(row.credits || 0), 0);
    const trialCredits = rows.reduce((sum, row) => sum + Number(row.trial_credits || 0), 0);
    const customers = rows.reduce((sum, row) => sum + Number(row.customers || 0), 0);

    const body = `${notice(req.query.message, 'success')}${notice(req.query.error, 'error')}
        <div class="metrics">
            <div class="metric"><div class="metricLabel">Resellers</div><div class="metricValue">${rows.length}</div></div>
            <div class="metric"><div class="metricLabel">Customers</div><div class="metricValue">${customers}</div></div>
            <div class="metric"><div class="metricLabel">Regular credits</div><div class="metricValue">${totalCredits}</div></div>
            <div class="metric"><div class="metricLabel">Trial credits</div><div class="metricValue">${trialCredits}</div></div>
        </div>
        <section class="section">
            <div class="sectionHead"><h2>Create reseller</h2><span class="muted">Uses configured reseller defaults</span></div>
            <form class="formPanel" method="post" action="/admin/reseller-management/create">
                ${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Username</label><input class="input" name="username" required pattern="[A-Za-z0-9._-]{3,40}"></div>
                    <div class="formGroup"><label>Email</label><input class="input" type="email" name="email"></div>
                    <div class="formGroup"><label>Initial regular credits</label><input class="input" type="number" min="0" max="100000" name="credits" value="${esc(defaults.credits)}"></div>
                    <div class="formGroup"><label>Initial trial credits</label><input class="input" type="number" min="0" max="20" name="trialCredits" value="${esc(defaults.trialCredits)}"></div>
                </div>
                ${stepInput()}
                <button class="button">Create reseller</button>
            </form>
        </section>
        <section class="section">
            <div class="sectionHead"><h2>Manage resellers</h2><span class="muted">${rows.length} total</span></div>
            ${rows.length ? `<div class="serverGrid">${rows.map(row => resellerCard(req, row)).join('')}</div>` : '<div class="empty">No resellers yet.</div>'}
        </section>`;

    return layout({
        siteName: site(),
        active: 'resellers',
        title: 'Resellers',
        subtitle: 'Accounts, customers, credits and access',
        body
    });
}

function createAdminResellersRouter() {
    const router = express.Router();
    router.use('/admin/reseller-management', gate);

    router.get('/admin/reseller-management', async (req, res, next) => {
        try {
            res.setHeader('Cache-Control', 'no-store, private, max-age=0');
            return res.send(await page(req));
        } catch (error) {
            return next(error);
        }
    });

    router.post('/admin/reseller-management/create', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (!(await requireStep(req))) return redirect(res, 'error', 'Authenticator verification failed.');
            const username = text(req.body.username, 40);
            const email = text(req.body.email, 254).toLowerCase() || null;
            if (!/^[A-Za-z0-9._-]{3,40}$/.test(username) || (email && !email.includes('@'))) {
                return redirect(res, 'error', 'Check the username and email.');
            }
            const credits = integer(req.body.credits, 0, 100000, 0);
            const trialCredits = integer(req.body.trialCredits, 0, 20, 0);
            const temporaryPassword = crypto.randomBytes(18).toString('base64url') + 'A1!';
            const hash = await bcrypt.hash(temporaryPassword, 12);

            await transaction(async client => {
                const user = await client.query(`
                    INSERT INTO app_users(email,username,password_hash,role,active,email_verified_at)
                    VALUES($1,$2,$3,'reseller',TRUE,CASE WHEN $1::text IS NULL THEN NULL ELSE NOW() END)
                    RETURNING id
                `, [email, username, hash]);
                const reseller = await client.query(
                    'INSERT INTO resellers(user_id,credits,trial_credits) VALUES($1,$2,$3) RETURNING id',
                    [user.rows[0].id, credits, trialCredits]
                );
                if (credits) {
                    await client.query(`
                        INSERT INTO credit_transactions(reseller_id,amount,transaction_type,note,created_by)
                        VALUES($1,$2,'add','Initial balance',$3)
                    `, [reseller.rows[0].id, credits, req.session.authUserId]);
                }
                await client.query(`
                    INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                    VALUES($1,'admin.reseller.create','reseller',$2,$3::jsonb)
                `, [req.session.authUserId, reseller.rows[0].id, JSON.stringify({ credits, trialCredits })]);
            });

            const body = `<div class="notice success">Reseller created.</div><section class="section"><div class="formPanel"><p><strong>Username:</strong> ${esc(username)}</p><p><strong>Temporary password:</strong></p><div class="codeBox">${esc(temporaryPassword)}</div><p class="muted">This password is shown once. Share it securely and ask the reseller to change it.</p><a class="button" href="/admin/reseller-management">Back to Resellers</a></div></section>`;
            res.setHeader('Cache-Control', 'no-store, private, max-age=0');
            return res.send(layout({ siteName: site(), active: 'resellers', title: 'Reseller created', body }));
        } catch (error) {
            console.error('Reseller create failed:', error.message);
            return redirect(res, 'error', error.code === '23505' ? 'That username or email already exists.' : 'Reseller could not be created safely.');
        }
    });

    router.post('/admin/reseller-management/:id/credits', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (!(await requireStep(req))) return redirect(res, 'error', 'Authenticator verification failed.');
            const regularDelta = integer(req.body.regularDelta, -100000, 100000, 0);
            const trialDelta = integer(req.body.trialDelta, -20, 20, 0);
            const note = text(req.body.note, 200);
            if (!regularDelta && !trialDelta) return redirect(res, 'error', 'Enter a credit adjustment first.');

            await transaction(async client => {
                const updated = await client.query(`
                    UPDATE resellers
                    SET credits=credits+$2,trial_credits=trial_credits+$3
                    WHERE id=$1 AND credits+$2>=0 AND trial_credits+$3 BETWEEN 0 AND 20
                    RETURNING credits,trial_credits
                `, [req.params.id, regularDelta, trialDelta]);
                if (!updated.rowCount) throw new Error('invalid_balance');
                if (regularDelta) {
                    await client.query(`
                        INSERT INTO credit_transactions(reseller_id,amount,transaction_type,note,created_by)
                        VALUES($1,$2,'adjustment',$3,$4)
                    `, [req.params.id, regularDelta, note, req.session.authUserId]);
                }
                await client.query(`
                    INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                    VALUES($1,'admin.reseller.credits','reseller',$2,$3::jsonb)
                `, [req.session.authUserId, req.params.id, JSON.stringify({ regularDelta, trialDelta, note })]);
            });
            return redirect(res, 'message', 'Credits updated.');
        } catch (error) {
            return redirect(res, 'error', error.message === 'invalid_balance' ? 'That adjustment would create an invalid balance.' : 'Credits could not be updated safely.');
        }
    });

    router.post('/admin/reseller-management/:id/status', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (!(await requireStep(req))) return redirect(res, 'error', 'Authenticator verification failed.');
            const active = String(req.body.active) === 'true';
            await transaction(async client => {
                const found = await client.query('SELECT user_id FROM resellers WHERE id=$1 FOR UPDATE', [req.params.id]);
                if (!found.rowCount) throw new Error('missing');
                const userId = found.rows[0].user_id;
                await client.query('UPDATE app_users SET active=$2,session_version=session_version+1,updated_at=NOW() WHERE id=$1', [userId, active]);
                await client.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1', [userId]);
                await client.query('DELETE FROM user_sessions us USING auth_sessions s WHERE us.sid=s.session_id AND s.user_id=$1', [userId]);
                await client.query(`
                    INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                    VALUES($1,'admin.reseller.status','reseller',$2,$3::jsonb)
                `, [req.session.authUserId, req.params.id, JSON.stringify({ active })]);
            });
            return redirect(res, 'message', active ? 'Reseller enabled.' : 'Reseller disabled and existing sessions revoked.');
        } catch (error) {
            return redirect(res, 'error', 'Reseller status could not be changed safely.');
        }
    });

    return router;
}

module.exports = { createAdminResellersRouter, listResellers };
