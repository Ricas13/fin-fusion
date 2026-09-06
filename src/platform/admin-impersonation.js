'use strict';

const express = require('express');
const crypto = require('crypto');
const csrf = require('../auth/csrf');
const { requireOwner, ownerStatus } = require('../auth/owner-guard');
const impersonationCredentials = require('../security/admin-impersonation-credentials');
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

// Impersonation is intentionally an "act on behalf of" mode, not a read-only
// preview. Owners may perform ordinary customer account/service mutations, but
// they must never create or increase a customer charge. Keep the spending
// boundary here, before every /account router, so UI changes cannot bypass it.
function restrictedImpersonationAction(req) {
    if (!req.session?.impersonation) return null;
    const method = String(req.method || '').toUpperCase();
    if (['GET','HEAD','OPTIONS'].includes(method)) return null;
    const path = String(req.path || req.originalUrl || '').split('?')[0].replace(/\/$/,'') || '/';
    if (!path.startsWith('/account')) return null;
    if (method === 'POST' && path === '/account/impersonation/exit') return null;

    // Starting checkout can charge now or establish recurring billing. Cancelling
    // an abandoned checkout is explicitly non-spending and remains available.
    if (path === '/account/checkout' || path.startsWith('/account/checkout/')) {
        if (path === '/account/checkout/cancel' || path === '/account/checkout/cancel-open') return null;
        return 'spending';
    }

    // The renewal endpoint handles both directions. Stopping renewal reduces
    // future spend; resuming it creates a future-charge obligation.
    if (path === '/account/subscription/renewal') {
        return String(req.body?.action || '').trim().toLowerCase() === 'resume' ? 'spending' : null;
    }

    // Future payment-instrument/purchase mutations should fail safe even if a
    // new UI reaches them before this policy is extended with a more specific
    // exception. Read-only GET billing/history pages are already allowed above.
    if (/^\/account\/(?:billing|payments?|payment-methods?|purchase|upgrade|add-ons?)(?:\/|$)/i.test(path)) return 'spending';

    return null;
}
function wantsJson(req) {
    const accept = String(req.get?.('accept') || req.headers?.accept || '').toLowerCase();
    const requestedWith = String(req.get?.('x-requested-with') || req.headers?.['x-requested-with'] || '').toLowerCase();
    return accept.includes('application/json') || requestedWith === 'xmlhttprequest';
}
function banner(req) {
    const imp = req.session?.impersonation;
    if (!imp) return '';
    const label = imp.displayName || imp.username || 'customer';
    return `<div class="captainfinImpersonation"><div><strong>Admin editing as customer: ${esc(label)}</strong><span>You can manage this customer's account and services. Purchases, payment-method changes, resumed renewal, and anything else that could create or increase a charge are disabled while impersonating.</span></div><form method="post" action="/account/impersonation/exit"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><button type="submit">Exit impersonation</button></form></div><style>.captainfinImpersonation{position:sticky;top:0;z-index:10000;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 18px;background:#5b2a10;color:#fff;border-bottom:1px solid #d9874b;font-family:Inter,ui-sans-serif,system-ui,sans-serif}.captainfinImpersonation strong{display:block;font-size:13px}.captainfinImpersonation span{display:block;margin-top:2px;font-size:11px;opacity:.86}.captainfinImpersonation form{margin:0}.captainfinImpersonation button{border:1px solid rgba(255,255,255,.45);background:rgba(255,255,255,.12);color:#fff;border-radius:7px;padding:7px 11px;font-weight:700;cursor:pointer}@media(max-width:650px){.captainfinImpersonation{align-items:flex-start;flex-direction:column}}</style>`;
}
function injectBanner(html, req) {
    if (typeof html !== 'string' || !req.session?.impersonation) return html;
    const value = banner(req);
    const body = /<body[^>]*>/i.exec(html);
    if (!body) return value + html;
    return html.slice(0,body.index + body[0].length) + value + html.slice(body.index + body[0].length);
}
function impersonateButton(req, customerId) {
    return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/impersonate" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><button class="button" type="submit">Manage customer portal</button></form>`;
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
    const restriction = restrictedImpersonationAction(req);
    res.once('finish', () => {
        query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.impersonation.customer_action','customer',$2,$3::jsonb)`, [snapshot.actorUserId,snapshot.customerId,JSON.stringify({ targetUserId:snapshot.customerUserId,method:req.method,path:String(req.originalUrl||req.path).slice(0,500),statusCode:res.statusCode,blockedByImpersonation:Boolean(restriction),restriction:restriction||null,impersonationId:snapshot.id })]).catch(error => console.error('Impersonation audit failed:', error.message));
    });
}
async function auditImpersonationEnd(imp, metadata = {}) {
    if (!imp) return;
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.impersonation.end','customer',$2,$3::jsonb)`, [imp.actorUserId,imp.customerId,JSON.stringify({ targetUserId:imp.customerUserId,impersonationId:imp.id,startedAt:imp.startedAt,...metadata })]);
}
function coherentOwnerImpersonation(req) {
    const imp=req.session?.impersonation;
    return Boolean(imp
        && req.session?.authUserId
        && req.session?.authRole==='admin'
        && String(imp.actorUserId)===String(req.session.authUserId)
        && String(imp.customerId)===String(req.session.customerId)
        && String(imp.customerUserId)===String(req.session.customerUserId));
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
        const restrictedAction = restrictedImpersonationAction(req);
        if (restrictedAction) {
            const message = 'Spending actions are disabled while impersonating. Exit impersonation to make a purchase, resume automatic renewal, or change payment details.';
            if (wantsJson(req)) return res.status(403).json({ error:'impersonation_spending_disabled', message });
            return res.status(403).send(message);
        }
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

    // Customer impersonation crosses the staff/customer privilege boundary and
    // therefore belongs to platform owners, not ordinary support administrators.
    router.post('/admin/users/:customerId/impersonate', gate, requireOwner, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const target = await targetCustomer(req.params.customerId);
            if (!target) throw new Error('Customer not found.');
            if (!eligibleTarget(target)) throw new Error('Only active customer portal accounts can be impersonated. Privileged/admin identities are never eligible.');

            const previous = req.session.impersonation ? { ...req.session.impersonation } : null;
            if (previous) {
                await auditImpersonationEnd(previous, {
                    endedReason: 'switched_customer',
                    switchedToCustomerId: target.customer_id,
                    switchedToUserId: target.user_id
                });
            }

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
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.impersonation.start','customer',$2,$3::jsonb)`, [req.session.authUserId,target.customer_id,JSON.stringify({ targetUserId:target.user_id,impersonationId:req.session.impersonation.id,mode:'admin_on_behalf_no_spend',replacedImpersonationId:previous?.id||null })]);
            await save(req);
            return res.redirect('/account');
        } catch (error) {
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?error=${encodeURIComponent(error.message)}`);
        }
    });

    // Exit deliberately remains available to any valid admin session that is
    // already impersonating, so stale/legacy sessions can always fail safely
    // back into the admin area even if owner status changed mid-session.
    router.post('/account/impersonation/exit', gate, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const imp = req.session.impersonation;
        if (!imp) return res.redirect('/admin/users');
        await auditImpersonationEnd(imp, { endedReason: 'explicit_exit' });
        const customerId = imp.customerId;
        delete req.session.impersonation;
        delete req.session.customerId;
        delete req.session.customerUserId;
        delete req.session.customerUsername;
        delete req.session.customerSessionVersion;
        await save(req);
        return res.redirect(`/admin/users/${encodeURIComponent(customerId)}`);
    });

    // Intercept the ordinary customer password endpoint only while impersonating.
    // Using middleware rather than a duplicate POST route keeps canonical route
    // ownership with customer-security for normal customer sessions.
    router.use('/account/security/password', async (req,res,next) => {
        if (req.method!=='POST' || !req.session?.impersonation) return next();
        try {
            if (!coherentOwnerImpersonation(req) || !await ownerStatus(req.session.authUserId)) return res.status(403).send('Owner impersonation is required for this action.');
            if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
            if (String(req.body?.newPassword||'') !== String(req.body?.confirmPassword||'')) throw new Error('New passwords do not match.');
            const changed=await impersonationCredentials.setPortalPassword({targetUserId:req.session.customerUserId,actorUserId:req.session.authUserId,newPassword:String(req.body?.newPassword||'')});
            req.session.customerSessionVersion=changed.sessionVersion;
            await save(req);
            return res.redirect('/account/security?message='+encodeURIComponent(`Portal password set by administrator. ${changed.revokedSessions} customer session(s) signed out.`));
        } catch (error) {
            return res.redirect('/account/security?error='+encodeURIComponent(error.message||'Portal password could not be changed.'));
        }
    });

    // Rewrite only the password form on Account Security while impersonating;
    // no existing password is displayed, read, or requested from the owner.
    router.use('/account/security', async (req,res,next) => {
        if (req.method!=='GET' || String(req.originalUrl||'').split('?')[0]!=='/account/security' || !req.session?.impersonation) return next();
        try {
            if (!coherentOwnerImpersonation(req) || !await ownerStatus(req.session.authUserId)) return next();
            const send=res.send.bind(res);
            res.send=body=>send(impersonationCredentials.rewriteSecurityPage(body));
            return next();
        } catch (error) {
            return next(error);
        }
    });

    // Add the action to Customer 360 without creating a second preview page.
    // This must stay mounted after the more specific /admin/users/* routes
    // (e.g. /admin/users/dashboard) so this wildcard never shadows them.
    router.use('/admin/users/:customerId', gate, async (req,res,next) => {
        if (req.method !== 'GET') return next();
        try {
            // Do not advertise an action to support admins that the owner-only
            // mutation boundary will reject. A failed lookup is fail-closed.
            if (!await ownerStatus(req.session.authUserId)) return next();
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

module.exports = { createAdminImpersonationRouter, createImpersonationAuditRouter, targetCustomer, eligibleTarget, restrictedImpersonationAction, wantsJson, injectBanner, injectAdminButton, coherentOwnerImpersonation };