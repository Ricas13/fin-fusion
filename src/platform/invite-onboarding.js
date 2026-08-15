'use strict';

const express = require('express');
const invitations = require('../invitations');
const csrf = require('../auth/csrf');
const branding = require('./branding');
const { esc } = require('./admin-html');

function site() { return process.env.SITE_NAME || 'CAPTaINFiN'; }
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function date(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function statusMessage(invitation) {
    const status = invitation?.status;
    if (status === 'used' || status === 'exhausted') return invitations.limitReachedMessage(invitation);
    if (status === 'expired') return 'This invitation has expired and is no longer available.';
    if (status === 'revoked') return 'This invitation has been revoked and is no longer available.';
    return 'This invitation link is invalid.';
}
function usageBadge(invitation) {
    if (invitation.maxUses == null) return 'Unlimited uses';
    if (invitation.maxUses === 1) return 'Single-use invite';
    return `${Number(invitation.remainingUses || 0).toLocaleString('en-GB')} of ${Number(invitation.maxUses).toLocaleString('en-GB')} uses remaining`;
}
function shell(title, body) {
    const name = site();
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)} · ${esc(name)}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><style>
        *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#0d1117;color:#e8edf3;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.invitePage{width:min(620px,calc(100% - 28px));margin:0 auto;padding:34px 0 56px}.inviteBrand{display:flex;align-items:center;gap:10px;color:#eef4f8;text-decoration:none;font-weight:800;margin-bottom:26px}.inviteBrand img{width:38px;height:38px;border-radius:9px;object-fit:cover}.inviteCard{background:#151b22;border:1px solid #2b3440;border-radius:12px;padding:22px;box-shadow:0 18px 55px rgba(0,0,0,.24)}h1{font-size:25px;margin:0 0 7px}.lead{color:#8f9cad;line-height:1.55;margin:0 0 20px}.planSummary{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:13px 14px;background:#10161d;border:1px solid #28313b;border-radius:8px;margin-bottom:19px}.planSummary strong{font-size:14px}.planSummary small{display:block;color:#748295;margin-top:3px}.pill{display:inline-flex;padding:4px 8px;border-radius:999px;border:1px solid rgba(32,169,214,.25);background:rgba(32,169,214,.08);color:#75d3ef;font-size:10px;font-weight:750}.field{display:grid;gap:5px;margin:0 0 12px}.field label{font-size:11px;color:#9aa7b6;font-weight:700}.input{width:100%;min-height:42px;padding:9px 10px;border:1px solid #343e49;border-radius:7px;background:#0f151b;color:#e8edf3;font-size:14px;outline:none}.input:focus{border-color:#2ca6ca;box-shadow:0 0 0 3px rgba(32,169,214,.1)}.input[readonly]{color:#aab5c1;background:#12171d}.button{width:100%;min-height:43px;border:1px solid #2d6474;border-radius:7px;background:#163844;color:#ecfbff;font-weight:800;cursor:pointer}.button:hover{background:#1b4654}.notice{padding:10px 12px;margin:0 0 15px;border-radius:7px;border:1px solid rgba(216,90,97,.26);background:rgba(216,90,97,.08);color:#f1a2a7;font-size:12px}.help{font-size:10px;color:#748295;line-height:1.45;margin-top:4px}.lockedEmail{padding:10px 11px;margin:0 0 12px;border:1px solid #28313b;border-radius:7px;background:#10161d;color:#aab5c1;font-size:12px}.lockedEmail strong{color:#e5ecf2}.footerNote{text-align:center;color:#657386;font-size:10px;margin-top:16px}@media(max-width:520px){.invitePage{padding-top:20px}.inviteCard{padding:17px}.planSummary{grid-template-columns:1fr}}
    </style></head><body><main class="invitePage"><a class="inviteBrand" href="/"><img src="${esc(branding.assetUrl('logo'))}" alt=""><span>${esc(name)}</span></a>${body}<div class="footerNote">Secure invitation onboarding</div></main></body></html>`;
}

function unavailablePage(message) {
    return shell('Invitation unavailable', `<section class="inviteCard"><h1>Invitation unavailable</h1><p class="lead">${esc(message)}</p><a href="/account/login" style="color:#72cce7">Customer sign in</a></section>`);
}

function formPage(req, invitation, values = {}, error = null) {
    const optionalEmail = String(values.email || '');
    const emailField = invitation.invitedEmail
        ? `<div class="lockedEmail">This invite is assigned to <strong>${esc(invitation.invitedEmail)}</strong>. You do not need to enter it again.</div>`
        : `<div class="field"><label>Email <span class="help">(optional)</span></label><input class="input" type="email" name="email" maxlength="254" autocomplete="email" value="${esc(optionalEmail)}"><div class="help">You can leave this blank and sign in with your username. Add an email only if you want it attached to the account.</div></div>`;
    const body = `<section class="inviteCard">
        <h1>Create your account</h1>
        <p class="lead">You have been invited to join ${esc(site())}. Choose your account details below.</p>
        ${error ? `<div class="notice">${esc(error)}</div>` : ''}
        <div class="planSummary"><div><strong>${esc(invitation.planName)}</strong><small>${esc(invitation.name)} · ${esc(invitation.planCode)} · expires ${esc(date(invitation.expiresAt))}</small></div><span class="pill">${esc(usageBadge(invitation))}</span></div>
        <form method="post" action="/invite/${encodeURIComponent(req.params.token)}">
            <input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">
            ${emailField}
            <div class="field"><label>Username</label><input class="input" name="username" minlength="3" maxlength="40" pattern="[A-Za-z0-9._-]{3,40}" autocomplete="username" required value="${esc(values.username || '')}"><div class="help">3–40 characters. Letters, numbers, dot, underscore and dash.</div></div>
            <div class="field"><label>Portal password</label><input class="input" type="password" name="password" minlength="12" maxlength="200" autocomplete="new-password" required><div class="help">At least 12 characters. This is only your CAPTaINFiN portal password. Jellyfin uses a separate password that you choose after provisioning.</div></div>
            <div class="field"><label>Confirm portal password</label><input class="input" type="password" name="confirmPassword" minlength="12" maxlength="200" autocomplete="new-password" required></div>
            <button class="button" type="submit">Create account</button>
        </form>
    </section>`;
    return shell('Accept invitation', body);
}

function invitationUsable(invitation) {
    return invitation && invitation.planActive && ['pending', 'active'].includes(invitation.status);
}

function createInviteOnboardingRouter() {
    const router = express.Router();
    router.use('/invite', noStore);

    router.get('/invite/:token', async (req, res, next) => {
        try {
            const invitation = await invitations.lookupInvitation(req.params.token);
            if (!invitation) return res.status(404).send(unavailablePage('This invitation link is invalid.'));
            if (!invitation.planActive) return res.status(410).send(unavailablePage('The plan attached to this invitation is no longer available.'));
            if (!invitationUsable(invitation)) return res.status(410).send(unavailablePage(statusMessage(invitation)));
            return res.send(formPage(req, invitation));
        } catch (error) { return next(error); }
    });

    router.post('/invite/:token', async (req, res, next) => {
        try {
            const invitation = await invitations.lookupInvitation(req.params.token);
            if (!invitation) return res.status(404).send(unavailablePage('This invitation link is invalid.'));
            if (!invitation.planActive) return res.status(410).send(unavailablePage('The plan attached to this invitation is no longer available.'));
            if (!invitationUsable(invitation)) return res.status(410).send(unavailablePage(statusMessage(invitation)));
            if (!csrf.verify(req)) return res.status(403).send(formPage(req, invitation, req.body, 'Your form expired. Please try again.'));
            if (String(req.body.password || '') !== String(req.body.confirmPassword || '')) {
                return res.status(400).send(formPage(req, invitation, req.body, 'Passwords do not match.'));
            }

            let redeemed;
            try {
                redeemed = await invitations.redeemInvitation({
                    token: req.params.token,
                    email: req.body.email || null,
                    username: req.body.username,
                    password: req.body.password
                });
            } catch (error) {
                const refreshed = await invitations.lookupInvitation(req.params.token);
                if (refreshed && !invitationUsable(refreshed)) {
                    return res.status(410).send(unavailablePage(statusMessage(refreshed)));
                }
                return res.status(400).send(formPage(req, invitation, req.body, error.message));
            }

            req.session.customerUserId = redeemed.user.id;
            req.session.customerId = redeemed.customer.id;
            req.session.customerUsername = redeemed.user.username;
            const message = redeemed.provisioningError
                ? 'Your account is ready. Jellyfin access is pending server provisioning and can be retried by an administrator.'
                : 'Welcome! Your portal account is ready. If Jellyfin was newly provisioned, choose its separate password from your account page before signing in to Jellyfin.';
            return res.redirect('/account?message=' + encodeURIComponent(message));
        } catch (error) { return next(error); }
    });

    router.use('/invite', (error, _req, res, _next) => {
        console.error('Invitation onboarding error:', error.message);
        return res.status(500).send(unavailablePage('The invitation could not be processed right now. Please try again later.'));
    });

    return router;
}

module.exports = { createInviteOnboardingRouter, formPage, unavailablePage, statusMessage, invitationUsable, usageBadge };
