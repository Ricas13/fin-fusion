'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const invitations = require('../invitations');
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
function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function absoluteUrl(req, path) {
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${proto}://${host}${path}`;
}
function date(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function statusPill(status) {
    const labels = { pending: 'Pending', active: 'Active', used: 'Used', expired: 'Expired', revoked: 'Revoked' };
    const cls = status === 'pending' || status === 'active' ? 'good' : status === 'used' ? 'accent' : status === 'expired' ? 'warn' : 'bad';
    return `<span class="pill ${cls}">${esc(labels[status] || status)}</span>`;
}

async function activePlans() {
    const result = await query(`
        SELECT id,name,code,billing_interval,duration_days,price_minor,currency,server_class
        FROM plans WHERE active=TRUE ORDER BY sort_order,price_minor,name
    `);
    return result.rows;
}

function createPanel(req, plans) {
    if (!plans.length) {
        return `<section class="section"><div class="sectionHead"><div><h2>Create invitation</h2><div class="muted">Secure customer onboarding links</div></div></div><div class="empty">No active plans are configured yet. <a href="/admin/plans/new">Create a plan</a> before issuing an invitation.</div></section>`;
    }
    return `<section class="section">
        <div class="sectionHead"><div><h2>Create invitation</h2><div class="muted">The customer chooses their own login and Jellyfin password.</div></div></div>
        <form class="formPanel invitationCreate" method="post" action="/admin/invitations" data-native-submit="true">
            ${csrfInput(req)}
            <div class="formGrid">
                <div class="formGroup"><label>Plan</label><select class="input" name="planId" required>${plans.map(plan => `<option value="${esc(plan.id)}">${esc(plan.name)} · ${esc(plan.server_class)}</option>`).join('')}</select></div>
                <div class="formGroup"><label>Email <span class="muted">(optional)</span></label><input class="input" type="email" name="email" maxlength="254" placeholder="customer@example.com"><div class="inlineHelp">Leave blank for a link that can be redeemed by any email address.</div></div>
                <div class="formGroup"><label>Expires after</label><select class="input" name="ttlHours"><option value="24">24 hours</option><option value="72" selected>3 days</option><option value="168">7 days</option><option value="336">14 days</option><option value="720">30 days</option></select></div>
            </div>
            <label class="toggleRow"><input type="checkbox" name="singleUse" checked><span><strong>Single-use link</strong><br><span class="muted">Recommended. Turn off only when intentionally using one reusable onboarding link.</span></span></label>
            <div class="buttonRow"><button class="button">Create invitation</button></div>
        </form>
    </section>`;
}

function invitationTable(req, rows) {
    if (!rows.length) return `<section class="section"><div class="sectionHead"><h2>Invitations</h2><span class="muted">0 total</span></div><div class="empty">No invitations yet.</div></section>`;
    return `<section class="section">
        <div class="sectionHead"><h2>Invitations</h2><span class="muted">${rows.length} total</span></div>
        <div class="tableWrap"><table class="dataTable invitationTable"><thead><tr><th>Status</th><th>Plan</th><th>Email</th><th>Type</th><th>Uses</th><th>Expires</th><th>Created</th><th class="right">Actions</th></tr></thead><tbody>
            ${rows.map(row => `<tr>
                <td>${statusPill(row.status)}</td>
                <td><strong>${esc(row.plan_name)}</strong><div class="planMeta">${esc(row.plan_code)}</div></td>
                <td>${row.invited_email ? esc(row.invited_email) : '<span class="muted">Any email</span>'}</td>
                <td>${row.single_use ? 'Single-use' : 'Reusable'}</td>
                <td>${Number(row.use_count || 0).toLocaleString('en-GB')}${row.last_redeemed_at ? `<div class="planMeta">Last ${esc(date(row.last_redeemed_at))}</div>` : ''}</td>
                <td>${esc(date(row.expires_at))}</td>
                <td>${esc(date(row.created_at))}</td>
                <td class="right"><div class="invitationActions">
                    ${['pending','active'].includes(row.status) ? `<form method="post" action="/admin/invitations/${esc(row.id)}/rotate" data-native-submit="true">${csrfInput(req)}<button class="button secondary" type="submit">New link</button></form><form method="post" action="/admin/invitations/${esc(row.id)}/revoke">${csrfInput(req)}<button class="button secondary" type="submit">Revoke</button></form>` : ''}
                </div></td>
            </tr>`).join('')}
        </tbody></table></div>
    </section>`;
}

async function page(req) {
    const [plans, rows] = await Promise.all([activePlans(), invitations.listInvitations()]);
    let created = '';
    const flash = req.session?.createdInvitation;
    if (flash?.token) {
        delete req.session.createdInvitation;
        const url = absoluteUrl(req, `/invite/${encodeURIComponent(flash.token)}`);
        created = `<div class="notice success inviteLinkNotice"><strong>Invitation ready.</strong> Copy this link now. For security, the token is not stored in recoverable form.<div class="inviteLinkRow"><input class="input" id="createdInviteLink" readonly value="${esc(url)}"><button class="button" type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('createdInviteLink').value)">Copy link</button></div></div>`;
    }
    const styles = `<style>.invitationCreate{max-width:none}.inviteLinkRow{display:flex;gap:7px;margin-top:8px}.inviteLinkRow .input{flex:1}.invitationActions{display:flex;justify-content:flex-end;gap:5px}.invitationActions form{margin:0}.invitationTable{min-width:980px}@media(max-width:700px){.inviteLinkRow{align-items:stretch;flex-direction:column}}</style>`;
    const body = `${notice(req)}${created}${styles}${createPanel(req, plans)}${invitationTable(req, rows)}`;
    return layout({ siteName: site(), active: 'invitations', title: 'Invitations', subtitle: 'Secure customer onboarding and plan assignment', body });
}

function createAdminInvitationsRouter() {
    const router = express.Router();
    router.use('/admin/invitations', gate, noStore);

    router.get('/admin/invitations', async (req, res, next) => {
        try { return res.send(await page(req)); }
        catch (error) { return next(error); }
    });

    router.post('/admin/invitations', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const created = await invitations.createInvitation({
                planId: req.body.planId,
                email: req.body.email,
                ttlHours: req.body.ttlHours,
                singleUse: req.body.singleUse === 'on',
                actorUserId: req.session.authUserId
            });
            req.session.createdInvitation = { id: created.invitation.id, token: created.token };
            return res.redirect('/admin/invitations?message=' + encodeURIComponent('Invitation created.'));
        } catch (error) {
            return res.redirect('/admin/invitations?error=' + encodeURIComponent(error.message || 'Invitation could not be created.'));
        }
    });

    router.post('/admin/invitations/:id/revoke', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await invitations.revokeInvitation(req.params.id, req.session.authUserId);
            return res.redirect('/admin/invitations?message=' + encodeURIComponent('Invitation revoked.'));
        } catch (error) {
            return res.redirect('/admin/invitations?error=' + encodeURIComponent(error.message || 'Invitation could not be revoked.'));
        }
    });

    router.post('/admin/invitations/:id/rotate', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const rotated = await invitations.rotateInvitation(req.params.id, req.session.authUserId);
            req.session.createdInvitation = { id: req.params.id, token: rotated.token };
            return res.redirect('/admin/invitations?message=' + encodeURIComponent('A new invitation link was generated. The previous link no longer works.'));
        } catch (error) {
            return res.redirect('/admin/invitations?error=' + encodeURIComponent(error.message || 'Invitation link could not be regenerated.'));
        }
    });

    return router;
}

module.exports = { createAdminInvitationsRouter, page, activePlans, absoluteUrl };
