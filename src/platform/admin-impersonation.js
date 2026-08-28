'use strict';

const express = require('express');
const crypto = require('crypto');
const csrf = require('../auth/csrf');
const { query } = require('../db');

function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function gate(req,res,next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function save(req) { return new Promise((resolve,reject) => req.session.save(error => error ? reject(error) : resolve())); }
async function targetCustomer(customerId) {
    const result = await query(`
        SELECT c.id AS customer_id,c.user_id,c.display_name,u.username,u.email,u.role,u.active,u.session_version
        FROM customers c
        LEFT JOIN app_users u ON u.id=c.user_id
        WHERE c.id=$1
        LIMIT 1
    `, [customerId]);
    return result.rows[0] || null;
}
function eligibleTarget(row) {
    return Boolean(row?.user_id && row?.active && row?.role === 'customer');
}
function banner(req) {
    const imp = req.session?.impersonation;
    if (!imp) return '';
    const label = imp.displayName || imp.username || 'customer';
    return `<div class="captainfinImpersonation"><div><strong>Impersonating ${esc(label)}</strong><span>You are using the real customer portal. Changes are audited as an administrator acting for this customer.</span></div><form method="post" action="/account/impersonation/exit"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><button type="submit">Exit impersonation</button></form></div><style>.captainfinImpersonation{position:sticky;top:0;z-index:10000;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 18px;background:#5b2a10;color:#fff;border-bottom:1px solid #d9874b;font-family:Inter,ui-sans-serif,system-ui,sans-serif}.captainfinImpersonation strong{display:block;font-size:13px}.captainfinImpersonation span{display:block;margin-top:2px;font-size:11px;opacity:.86}.captainfinImpersonation form{margin:0}.captainfinImpersonation button{border:1px solid rgba(255,255,255,.45);background:rgba(255,255,255,.12);color:#fff;border-radius:7px;padding:7px 11px;font-weight:700;cursor:pointer}@media(max-width:650px){.captainfinImpersonation{align-items:flex-start;flex-direction:column}}</style>`;
}
function injectBanner(html, req) {
    if (typeof html !== 'string' || !req.session?.impersonation) return html;
    const value = banner(req);
    const body = /<body[^>]*>/i.exec(html);
    if (!body) return value + html;
    return html.slice(0,body.index + body[0].length) + value + html.slice(body.index + body[0].length);
}
function impersonateButton(req, customerId) {
    return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/impersonate" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><button class="button" type="submit">View portal as customer</button></form>`;
}
function injectAdminButton(html, req, customerId) {
    if (typeof html !== 'string') return html;
    const button = impersonateButton(req, customerId);
    const marker = '<a class="button secondary" href="/admin/users">Back to Customers</a>';
    if (html.includes(marker)) return html.replace(marker, button + marker);
    return html;
}
async function auditImpersonatedMutation(req,res) {
    const imp = req.session?.impersonation;
    if (!imp || !req.path.startsWith('/account') || ['GET','HEAD','OPTIONS'].includes(req.method)) return;
    const snapshot = { ...imp };
    res.once('finish', () => {
        if (res.statusCode >= 400) return;
        query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.impersonation.customer_action','customer',$2,$3::jsonb)`, [snapshot.actorUserId,snapshot.customerId,JSON.stringify({ targetUserId:snapshot.customerUserId,method:req.method,path:String(req.originalUrl||req.path).slice(0,500),statusCode:res.statusCode,impersonationId:snapshot.id })]).catch(error => console.error('Impersonation audit failed:', error.message));
    });
}

// Mounted very early in application.js, before every /account router: an
// earlier-mounted account router that sends its own response would otherwise
// stop the request from ever reaching a later-mounted audit/banner pass. This
// router owns only that catch-all concern, not any specific route, so it
// can never shadow a more specific route mounted later (e.g. /admin/users/dashboard).
function createImpersonationAuditRouter() {
    const router = express.Router();
    router.use(async (req,res,next) => {
        await auditImpersonatedMutation(req,res);
        if (req.session?.impersonation && req.path.startsWith('/account')) {
            const send = res.send.bind(res);
            res.send = body => send(injectBanner(body,req));
        }
        return next();
    });
    return router;
}

function createAdminImpersonationRouter() {
    const router = express.Router();

    router.post('/admin/users/:customerId/impersonate', gate, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        if (req.session.impersonation) return res.status(409).send('Nested impersonation is not allowed. Exit the current impersonation first.');
        try {
            const target = await targetCustomer(req.params.customerId);
            if (!target) throw new Error('Customer not found.');
            if (!eligibleTarget(target)) throw new Error('Only active customer portal accounts can be impersonated. Privileged/admin identities are never eligible.');
            req.session.impersonation = {
                id: crypto.randomUUID(),
                actorUserId: req.session.authUserId,
                actorAdminId: req.session.adminId,
                customerId: target.customer_id,
                customerUserId: target.user_id,
                username: target.username,
                displayName: target.display_name || target.username,
                startedAt: new Date().toISOString()
            };
            req.session.customerId = target.customer_id;
            req.session.customerUserId = target.user_id;
            req.session.customerUsername = target.username;
            req.session.customerSessionVersion = Number(target.session_version || 1);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.impersonation.start','customer',$2,$3::jsonb)`, [req.session.authUserId,target.customer_id,JSON.stringify({ targetUserId:target.user_id,impersonationId:req.session.impersonation.id })]);
            await save(req);
            return res.redirect('/account');
        } catch (error) {
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?error=${encodeURIComponent(error.message)}`);
        }
    });

    router.post('/account/impersonation/exit', gate, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const imp = req.session.impersonation;
        if (!imp) return res.redirect('/admin/users');
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.impersonation.end','customer',$2,$3::jsonb)`, [imp.actorUserId,imp.customerId,JSON.stringify({ targetUserId:imp.customerUserId,impersonationId:imp.id,startedAt:imp.startedAt })]);
        const customerId = imp.customerId;
        delete req.session.impersonation;
        delete req.session.customerId;
        delete req.session.customerUserId;
        delete req.session.customerUsername;
        delete req.session.customerSessionVersion;
        await save(req);
        return res.redirect(`/admin/users/${encodeURIComponent(customerId)}`);
    });

    // Add the action to Customer 360 without creating a second preview page.
    // This must stay mounted after the more specific /admin/users/* routes
    // (e.g. /admin/users/dashboard) so this wildcard never shadows them.
    router.use('/admin/users/:customerId', gate, async (req,res,next) => {
        if (req.method !== 'GET') return next();
        try {
            const target = await targetCustomer(req.params.customerId);
            if (!eligibleTarget(target)) return next();
            const send = res.send.bind(res);
            res.send = body => send(injectAdminButton(body,req,req.params.customerId));
            return next();
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

module.exports = { createAdminImpersonationRouter, createImpersonationAuditRouter, targetCustomer, eligibleTarget, injectBanner, injectAdminButton };
