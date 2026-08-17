'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const { layout, esc } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function optionalLimit(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error('Request quota must be between 1 and 10,000, or left blank for unlimited.');
    return n;
}
function days(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error('Quota window must be between 1 and 3,650 days.');
    return n;
}

async function plans() {
    const result = await query(`
        SELECT id,code,name,audience,billing_interval,duration_days,active,visible,
               request_movie_quota_limit,request_movie_quota_days,
               request_tv_quota_limit,request_tv_quota_days,
               (SELECT COUNT(DISTINCT s.customer_id)::int
                FROM subscriptions s
                WHERE s.plan_id=p.id
                  AND s.status IN ('active','trialing','past_due')
                  AND s.current_period_end>NOW()) AS active_customers
        FROM plans p
        ORDER BY active DESC,sort_order,price_minor,name
    `);
    return result.rows;
}

function quotaLabel(limit, window) {
    return limit == null ? 'Unlimited' : `${limit} / ${window} day${Number(window) === 1 ? '' : 's'}`;
}

async function page(req) {
    const rows = await plans();
    const tableRows = rows.map(plan => `<tr>
        <td><strong>${esc(plan.name)}</strong><div class="planMeta">${esc(plan.code)} · ${esc(plan.billing_interval)} · ${plan.active ? 'active' : 'archived'}</div></td>
        <td><strong>${esc(quotaLabel(plan.request_movie_quota_limit, plan.request_movie_quota_days))}</strong></td>
        <td><strong>${esc(quotaLabel(plan.request_tv_quota_limit, plan.request_tv_quota_days))}</strong><div class="planMeta">TV quota is counted by requested seasons in Overseerr/Seerr.</div></td>
        <td>${esc(plan.active_customers || 0)}</td>
        <td class="right">
          <details class="detailsBox quotaEditor"><summary>Edit limits</summary>
            <form method="post" action="/admin/request-plan-policy/${esc(plan.id)}">
              ${csrfInput(req)}
              <div class="formGrid quotaGrid">
                <div class="formGroup"><label>Movie requests</label><input class="input" type="number" min="1" max="10000" name="movieLimit" value="${esc(plan.request_movie_quota_limit ?? '')}" placeholder="Unlimited"><div class="inlineHelp">Leave blank for unlimited.</div></div>
                <div class="formGroup"><label>Movie window · days</label><input class="input" type="number" min="1" max="3650" name="movieDays" value="${esc(plan.request_movie_quota_days || 30)}"></div>
                <div class="formGroup"><label>TV season requests</label><input class="input" type="number" min="1" max="10000" name="tvLimit" value="${esc(plan.request_tv_quota_limit ?? '')}" placeholder="Unlimited"><div class="inlineHelp">Overseerr counts seasons, not whole series.</div></div>
                <div class="formGroup"><label>TV window · days</label><input class="input" type="number" min="1" max="3650" name="tvDays" value="${esc(plan.request_tv_quota_days || 30)}"></div>
              </div>
              <button class="button" type="submit">Save request limits</button>
            </form>
          </details>
        </td>
    </tr>`).join('');

    const body = `${notice(req)}
      <section class="card">
        <div class="card-header"><div><h2 class="card-title">How plan quotas work</h2><div class="muted">Limits are pushed to the central Overseerr/Seerr account whenever request users synchronize.</div></div></div>
        <div class="card-body">
          <div class="compact-item"><div><div class="compact-title">Per-plan policy</div><div class="compact-meta">Movie and TV limits are configured independently. A blank limit means unlimited for that media type.</div></div><span class="pill good">Plan controlled</span></div>
          <div class="compact-item"><div><div class="compact-title">Rolling quota window</div><div class="compact-meta">Overseerr/Seerr applies quotas over the configured number of days. For example: 2 movies every 30 days.</div></div><span class="pill">Native quota</span></div>
          <div class="compact-item"><div><div class="compact-title">TV counting</div><div class="compact-meta">The request service's native TV quota counts requested seasons. A request for three seasons consumes three TV quota units.</div></div><span class="pill warn">Season based</span></div>
          <div class="compact-item"><div><div class="compact-title">Subscription lifecycle</div><div class="compact-meta">When access expires, request permissions are suspended without deleting the request account/history. Renewal restores the remembered permissions and current plan quotas.</div></div><span class="pill good">Automatic</span></div>
        </div>
      </section>
      <section class="section">
        <div class="sectionHead"><div><h2>Plan request limits</h2><div class="muted">Existing plans remain unlimited until you set a limit.</div></div><span class="muted">${rows.length} plan${rows.length === 1 ? '' : 's'}</span></div>
        ${rows.length ? `<div class="tableWrap"><table class="dataTable quotaTable"><thead><tr><th>Plan</th><th>Movies</th><th>TV seasons</th><th>Active customers</th><th class="right">Configure</th></tr></thead><tbody>${tableRows}</tbody></table></div>` : '<div class="empty">No plans exist yet.</div>'}
      </section>
      <style>.quotaTable{min-width:980px}.quotaEditor{min-width:180px;text-align:left}.quotaEditor form{padding-top:12px}.quotaGrid{min-width:620px}.quotaEditor[open]{position:relative;z-index:2}@media(max-width:760px){.quotaGrid{min-width:0;grid-template-columns:1fr}.quotaEditor{min-width:0}}</style>`;

    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'request-plan-limits',
        title: 'Plan Request Limits',
        subtitle: 'Movie and TV request quotas for the central Overseerr/Seerr service',
        body
    });
}

function createAdminRequestPlanPolicyRouter() {
    const router = express.Router();
    router.use('/admin/request-plan-policy', gate, noStore);
    router.get('/admin/request-plan-policy', async (req, res, next) => {
        try { return res.send(await page(req)); } catch (error) { return next(error); }
    });
    router.post('/admin/request-plan-policy/:planId', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const movieLimit = optionalLimit(req.body.movieLimit);
            const movieDays = days(req.body.movieDays);
            const tvLimit = optionalLimit(req.body.tvLimit);
            const tvDays = days(req.body.tvDays);
            const updated = await query(`
                UPDATE plans SET
                    request_movie_quota_limit=$2,request_movie_quota_days=$3,
                    request_tv_quota_limit=$4,request_tv_quota_days=$5,
                    updated_at=NOW()
                WHERE id=$1
                RETURNING name
            `, [req.params.planId, movieLimit, movieDays, tvLimit, tvDays]);
            if (!updated.rowCount) throw new Error('Plan not found.');
            await query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'plan.request_policy.update','plan',$2,$3::jsonb)
            `, [req.session.authUserId, req.params.planId, JSON.stringify({ movieLimit, movieDays, tvLimit, tvDays })]);
            const message = `${updated.rows[0].name} request limits saved. Active request users will receive the new limits on the next sync.`;
            return res.redirect('/admin/request-plan-policy?message=' + encodeURIComponent(message));
        } catch (error) {
            return res.redirect('/admin/request-plan-policy?error=' + encodeURIComponent(error.message || 'Request limits could not be saved.'));
        }
    });
    return router;
}

module.exports = { createAdminRequestPlanPolicyRouter, page, optionalLimit, days, plans };
