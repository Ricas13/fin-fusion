'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { query } = require('../db');
const policy = require('../jellyfin/policy');
const overrides = require('../jellyfin/lane-policy-overrides');
const subscriptionState = require('../entitlements/subscription-state');
const provisioning = require('../jellyfin/resilient-provisioning');

const LABELS = {
    streams: 'Concurrent streams',
    allow_downloads: 'Downloads',
    allow_video_transcoding: 'Video transcode',
    allow_audio_transcoding: 'Audio transcode',
    allow_remuxing: 'Remuxing',
    allow_live_tv: 'Live TV',
    allow_live_tv_management: 'Live TV recording',
    allow_remote_access: 'Remote access',
    allow_subtitle_editing: 'Subtitle editing'
};

function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function gate(req,res,next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function targetLane(value) { return overrides.lane(value || 'primary'); }
function fieldValue(field, value) {
    if (value === null || value === undefined) return '—';
    if (field === 'streams') return esc(value);
    return value ? 'Yes' : 'No';
}
function fieldControl(field, row) {
    const has = row.override !== null;
    if (field === 'streams') return `<input class="input compact" type="number" name="${esc(field)}" min="1" max="50" placeholder="Inherit" value="${has ? esc(row.override) : ''}">`;
    return `<select class="input compact" name="${esc(field)}"><option value="" ${!has?'selected':''}>Inherit</option><option value="true" ${has&&row.override===true?'selected':''}>On</option><option value="false" ${has&&row.override===false?'selected':''}>Off</option></select>`;
}
async function laneEntitlements(customerId) {
    const [primaryRaw, free] = await Promise.all([
        subscriptionState.effectiveSubscription(customerId, { includeBlocked: true }),
        subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked: true })
    ]);
    return { primary: primaryRaw && !primaryRaw.is_free_tier ? primaryRaw : null, free: free || null };
}
async function lanePanel(req, customerId, accessLane, plan) {
    const title = accessLane === 'free' ? 'Free Access policy' : 'Premium Jellyfin policy';
    if (!plan) return `<section class="section"><div class="sectionHead"><div><h2>${title}</h2><div class="muted">No current ${accessLane === 'free' ? 'Free' : 'Premium'} Jellyfin entitlement.</div></div><span class="pill">Inactive</span></div></section>`;
    const effective = await overrides.effectiveTechnical(customerId, accessLane, plan);
    const rows = policy.TECHNICAL_FIELDS.map(field => {
        const row = effective.technicalRows[field];
        return `<tr><td>${esc(LABELS[field] || field)}</td><td>${fieldValue(field,row.plan)}</td><td>${fieldValue(field,row.override)}</td><td><strong>${fieldValue(field,row.effective)}</strong></td><td>${fieldControl(field,row)}</td></tr>`;
    }).join('');
    const planName = plan.contract_plan_name || plan.name || plan.code || accessLane;
    return `<section class="section"><div class="sectionHead"><div><h2>${title}</h2><div class="muted">${esc(planName)} · overrides affect only this Jellyfin identity/lane.</div></div><span class="pill ${plan.blocked?'warn':'good'}">${plan.blocked?'Blocked':'Active'}</span></div><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(customerId)}/lane-policy-overrides"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="accessLane" value="${esc(accessLane)}"><div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Field</th><th>Plan</th><th>Override</th><th>Effective</th><th>Set override</th></tr></thead><tbody>${rows}</tbody></table></div><div class="buttonRow"><button class="button">Save ${accessLane === 'free' ? 'Free' : 'Premium'} overrides</button></div></form><form class="formPanel compactAction" method="post" action="/admin/users/${encodeURIComponent(customerId)}/lane-policy-overrides/reset-all"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="accessLane" value="${esc(accessLane)}"><button class="button secondary">Reset this lane to plan</button></form></section>`;
}
async function laneSections(req, customerId) {
    const entitlements = await laneEntitlements(customerId);
    return `<div class="notice">Playback quotas and Jellyfin technical permissions are enforced independently per access lane. Free capacity never reduces or expands Premium capacity.</div>${await lanePanel(req,customerId,'primary',entitlements.primary)}${await lanePanel(req,customerId,'free',entitlements.free)}`;
}
function replaceLegacyEffectivePolicy(html, replacement) {
    if (typeof html !== 'string') return html;
    const pattern = /<section class="section"><div class="sectionHead"><h2>Effective policy<\/h2>[\s\S]*?<\/section>/;
    if (pattern.test(html)) return html.replace(pattern, replacement);
    const marker = '<section class="section"><div class="sectionHead"><h2>Provisioning history</h2>';
    return html.includes(marker) ? html.replace(marker, replacement + marker) : html;
}

function createAdminLanePolicyRouter() {
    const router = express.Router();

    router.post('/admin/users/:customerId/lane-policy-overrides', gate, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const accessLane = targetLane(req.body.accessLane);
        try {
            const changed = [];
            for (const field of policy.TECHNICAL_FIELDS) {
                if (req.body[field] === undefined) continue;
                const raw = String(req.body[field]).trim();
                if (raw === '') await overrides.resetPolicyOverrideField(req.params.customerId,accessLane,field,req.session.authUserId);
                else if (field === 'streams') await overrides.setPolicyOverrideField(req.params.customerId,accessLane,field,Number.parseInt(raw,10),req.session.authUserId);
                else {
                    if (!['true','false'].includes(raw)) throw new Error(`Invalid ${field} override.`);
                    await overrides.setPolicyOverrideField(req.params.customerId,accessLane,field,raw === 'true',req.session.authUserId);
                }
                changed.push(field);
            }
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.lane_policy_override','customer',$2,$3::jsonb)`, [req.session.authUserId,req.params.customerId,JSON.stringify({ accessLane, fields: changed })]);
            let note = '';
            try { await provisioning.reconcileCustomer(req.params.customerId); } catch (_) { note = ' Jellyfin reconciliation is still catching up.'; }
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?tab=access&message=${encodeURIComponent(`${accessLane === 'free' ? 'Free' : 'Premium'} policy overrides saved.${note}`)}`);
        } catch (error) {
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?tab=access&error=${encodeURIComponent(error.message)}`);
        }
    });

    router.post('/admin/users/:customerId/lane-policy-overrides/reset-all', gate, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const accessLane = targetLane(req.body.accessLane);
        try {
            await overrides.resetAllPolicyOverrides(req.params.customerId,accessLane,req.session.authUserId);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.lane_policy_override_reset_all','customer',$2,$3::jsonb)`, [req.session.authUserId,req.params.customerId,JSON.stringify({ accessLane })]);
            try { await provisioning.reconcileCustomer(req.params.customerId); } catch (_) {}
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?tab=access&message=${encodeURIComponent(`${accessLane === 'free' ? 'Free' : 'Premium'} policy reset to plan.`)}`);
        } catch (error) {
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?tab=access&error=${encodeURIComponent(error.message)}`);
        }
    });

    router.use('/admin/users/:customerId', gate, async (req,res,next) => {
        if (req.method !== 'GET' || String(req.query.tab || 'overview') !== 'access') return next();
        try {
            const sections = await laneSections(req, req.params.customerId);
            const send = res.send.bind(res);
            res.send = body => send(replaceLegacyEffectivePolicy(body, sections));
            return next();
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

module.exports = { createAdminLanePolicyRouter, laneEntitlements, laneSections, replaceLegacyEffectivePolicy };
