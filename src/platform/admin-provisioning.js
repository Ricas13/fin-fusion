'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const provisioning = require('../jellyfin/resilient-provisioning');
const { esc, layout } = require('./admin-html');

function site() { return process.env.SITE_NAME || 'CAPTaINFiN'; }
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
function dt(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function pill(status) {
    const label = status || 'pending';
    const kind = label === 'healthy' ? 'good' : label === 'blocked' ? 'warn' : label === 'failed' ? 'bad' : label === 'running' ? 'accent' : '';
    return `<span class="pill ${kind}">${esc(label[0].toUpperCase() + label.slice(1))}</span>`;
}

async function activeCustomerCount() {
    const result = await query(`
        SELECT COUNT(DISTINCT s.customer_id)::int AS count
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.status IN ('active','trialing','past_due')
          AND s.current_period_end > NOW() AND p.active=TRUE
    `);
    return result.rows[0].count;
}

async function statusCounts() {
    const result = await query(`
        SELECT status,COUNT(*)::int AS count
        FROM customer_provisioning_state GROUP BY status
    `);
    return Object.fromEntries(result.rows.map(row => [row.status, row.count]));
}

async function provisioningRows() {
    const result = await query(`
        WITH active AS (
            SELECT DISTINCT ON (s.customer_id)
                   s.customer_id,s.id AS subscription_id,s.status AS subscription_status,
                   s.current_period_end,p.id AS plan_id,p.name AS plan_name,p.code AS plan_code,p.server_class
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.status IN ('active','trialing','past_due')
              AND s.current_period_end > NOW() AND p.active=TRUE
            ORDER BY s.customer_id,s.current_period_end DESC,s.created_at DESC
        )
        SELECT c.id AS customer_id,
               COALESCE(NULLIF(c.display_name,''),u.username,c.email,'Customer') AS customer_name,
               u.username,c.email,
               a.subscription_id,a.subscription_status,a.current_period_end,
               a.plan_id,a.plan_name,a.plan_code,a.server_class,
               cps.status,cps.attempt_count,cps.consecutive_failures,cps.last_error,
               cps.last_attempt_at,cps.last_success_at,cps.next_attempt_at,cps.updated_at,
               ja.id AS jellyfin_account_id,ja.jellyfin_username,ja.disabled AS jellyfin_disabled,
               js.id AS server_id,js.name AS server_name,js.health_status AS server_health,
               jpr.status AS policy_status,jpr.last_error AS policy_error,
               jpr.last_attempt_at AS policy_last_attempt,jpr.last_success_at AS policy_last_success,
               jpr.last_verified_at AS policy_last_verified,jpr.drift_detected_at
        FROM customers c
        LEFT JOIN app_users u ON u.id=c.user_id
        LEFT JOIN active a ON a.customer_id=c.id
        LEFT JOIN customer_provisioning_state cps ON cps.customer_id=c.id
        LEFT JOIN jellyfin_accounts ja ON ja.id=cps.jellyfin_account_id
        LEFT JOIN jellyfin_servers js ON js.id=COALESCE(cps.server_id,ja.server_id)
        LEFT JOIN jellyfin_policy_reconciliation jpr ON jpr.jellyfin_account_id=ja.id
        WHERE a.subscription_id IS NOT NULL OR cps.status IN ('pending','running','blocked','failed')
        ORDER BY CASE COALESCE(cps.status,'pending')
                    WHEN 'failed' THEN 1 WHEN 'blocked' THEN 2 WHEN 'running' THEN 3
                    WHEN 'pending' THEN 4 ELSE 5 END,
                 COALESCE(cps.next_attempt_at,cps.updated_at,c.created_at),customer_name
        LIMIT 400
    `);
    return result.rows;
}

async function recentRuns() {
    const result = await query(`
        SELECT pr.id,pr.customer_id,pr.action,pr.status,pr.detail,pr.started_at,pr.completed_at,
               COALESCE(NULLIF(c.display_name,''),u.username,c.email,'Customer') AS customer_name
        FROM provisioning_runs pr
        JOIN customers c ON c.id=pr.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        ORDER BY pr.started_at DESC LIMIT 40
    `);
    return result.rows;
}

async function queueAllActive() {
    const result = await query(`
        INSERT INTO customer_provisioning_state(customer_id,status,next_attempt_at,updated_at)
        SELECT DISTINCT s.customer_id,'pending',NOW(),NOW()
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.status IN ('active','trialing','past_due')
          AND s.current_period_end > NOW() AND p.active=TRUE
        ON CONFLICT (customer_id) DO UPDATE SET status='pending',next_attempt_at=NOW(),updated_at=NOW()
        RETURNING customer_id
    `);
    return result.rowCount;
}

function stateTable(req, rows) {
    if (!rows.length) return `<section class="section"><div class="sectionHead"><h2>Customer provisioning</h2></div><div class="empty">No customers currently require provisioning. This is a valid empty state.</div></section>`;
    return `<section class="section"><div class="sectionHead"><div><h2>Customer provisioning</h2><div class="muted">Current desired-access reconciliation state</div></div><span class="muted">${rows.length} shown</span></div>
        <div class="tableWrap"><table class="dataTable provisioningTable"><thead><tr><th>Customer</th><th>Plan</th><th>State</th><th>Jellyfin</th><th>Last attempt</th><th>Next attempt</th><th>Problem</th><th class="right">Action</th></tr></thead><tbody>
        ${rows.map(row => {
            const status = row.status || 'pending';
            const jellyfin = row.jellyfin_account_id
                ? `<strong>${esc(row.jellyfin_username || 'Account')}</strong><div class="planMeta">${esc(row.server_name || 'Unknown server')} · ${esc(row.server_health || 'unknown')}</div>`
                : '<span class="muted">Not created yet</span>';
            const problem = row.last_error || row.policy_error || '—';
            return `<tr><td><strong>${esc(row.customer_name)}</strong><div class="planMeta">${esc(row.username || row.email || row.customer_id)}</div></td>
                <td>${row.plan_name ? `<strong>${esc(row.plan_name)}</strong><div class="planMeta">${esc(row.plan_code)} · ${esc(row.server_class)}</div>` : '<span class="muted">No active plan</span>'}</td>
                <td>${pill(status)}${row.consecutive_failures ? `<div class="planMeta">${esc(row.consecutive_failures)} consecutive failure${row.consecutive_failures === 1 ? '' : 's'}</div>` : ''}</td>
                <td>${jellyfin}</td><td>${esc(dt(row.last_attempt_at))}</td><td>${esc(dt(row.next_attempt_at))}</td>
                <td class="problemCell" title="${esc(problem)}">${esc(problem)}</td>
                <td class="right"><form method="post" action="/admin/provisioning/${esc(row.customer_id)}/reconcile">${csrfInput(req)}<button class="button secondary" type="submit">Reconcile now</button></form></td></tr>`;
        }).join('')}</tbody></table></div></section>`;
}

function runsTable(rows) {
    if (!rows.length) return '';
    return `<section class="section"><div class="sectionHead"><div><h2>Recent attempts</h2><div class="muted">Append-only provisioning history</div></div></div><div class="tableWrap"><table class="dataTable"><thead><tr><th>Customer</th><th>Action</th><th>Status</th><th>Started</th><th>Duration</th><th>Error</th></tr></thead><tbody>${rows.map(row => {
        const started = row.started_at ? new Date(row.started_at).getTime() : 0;
        const completed = row.completed_at ? new Date(row.completed_at).getTime() : Date.now();
        const duration = started ? `${Math.max(0, Math.round((completed - started) / 100) / 10)}s` : '—';
        const error = row.detail?.error || '—';
        return `<tr><td>${esc(row.customer_name)}</td><td>${esc(row.action)}</td><td>${pill(row.status === 'succeeded' ? 'healthy' : row.status)}</td><td>${esc(dt(row.started_at))}</td><td>${esc(duration)}</td><td class="problemCell">${esc(error)}</td></tr>`;
    }).join('')}</tbody></table></div></section>`;
}

async function page(req) {
    const [active, counts, rows, runs] = await Promise.all([activeCustomerCount(), statusCounts(), provisioningRows(), recentRuns()]);
    const healthy = counts.healthy || 0;
    const blocked = counts.blocked || 0;
    const failed = counts.failed || 0;
    const pending = (counts.pending || 0) + (counts.running || 0);
    const styles = `<style>.provisioningActions{display:flex;gap:7px;flex-wrap:wrap}.provisioningActions form{margin:0}.provisioningTable{min-width:1180px}.problemCell{max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metricValue.smallish{font-size:22px}@media(max-width:760px){.provisioningActions{width:100%}.provisioningActions .button{flex:1}}</style>`;
    const actions = `<div class="provisioningActions"><form method="post" action="/admin/provisioning/retry-problems">${csrfInput(req)}<button class="button secondary" type="submit">Retry blocked & failed</button></form><form method="post" action="/admin/provisioning/reconcile-all">${csrfInput(req)}<button class="button" type="submit">Queue all active</button></form></div>`;
    const metrics = `<div class="metrics"><div class="metric"><div class="metricLabel">Active customers</div><div class="metricValue smallish">${active}</div></div><div class="metric"><div class="metricLabel">Healthy</div><div class="metricValue smallish">${healthy}</div></div><div class="metric"><div class="metricLabel">Pending / running</div><div class="metricValue smallish">${pending}</div></div><div class="metric"><div class="metricLabel">Blocked</div><div class="metricValue smallish">${blocked}</div></div><div class="metric"><div class="metricLabel">Failed</div><div class="metricValue smallish">${failed}</div></div></div>`;
    const body = `${styles}${notice(req)}${metrics}${stateTable(req, rows)}${runsTable(runs)}`;
    return layout({ siteName: site(), active: 'provisioning', title: 'Provisioning', subtitle: 'Jellyfin account creation, policy reconciliation, retries and failures', action: actions, body });
}

function createAdminProvisioningRouter() {
    const router = express.Router();
    router.use('/admin/provisioning', gate, noStore);
    router.get('/admin/provisioning', async (req, res, next) => {
        try { return res.send(await page(req)); } catch (error) { return next(error); }
    });
    router.post('/admin/provisioning/:customerId/reconcile', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await provisioning.control.forceCustomerDue(req.params.customerId);
            await provisioning.reconcileCustomer(req.params.customerId);
            return res.redirect('/admin/provisioning?message=' + encodeURIComponent('Customer reconciled successfully.'));
        } catch (error) {
            return res.redirect('/admin/provisioning?error=' + encodeURIComponent(error.message || 'Customer reconciliation failed.'));
        }
    });
    router.post('/admin/provisioning/retry-problems', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const count = await provisioning.control.forceAllProblemsDue();
            return res.redirect('/admin/provisioning?message=' + encodeURIComponent(`${count} blocked/failed customer${count === 1 ? '' : 's'} queued for retry.`));
        } catch (error) {
            return res.redirect('/admin/provisioning?error=' + encodeURIComponent(error.message || 'Retry queue could not be updated.'));
        }
    });
    router.post('/admin/provisioning/reconcile-all', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const count = await queueAllActive();
            return res.redirect('/admin/provisioning?message=' + encodeURIComponent(`${count} active customer${count === 1 ? '' : 's'} queued for reconciliation.`));
        } catch (error) {
            return res.redirect('/admin/provisioning?error=' + encodeURIComponent(error.message || 'Active customers could not be queued.'));
        }
    });
    return router;
}

module.exports = { createAdminProvisioningRouter, page, provisioningRows, queueAllActive };
