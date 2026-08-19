'use strict';

const { query } = require('../db');
const csrf = require('../auth/csrf');
const { esc } = require('./admin-html');

function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}

async function customerCreate(req) {
    const plans = await query(`
        SELECT code,name,service_type,price_minor,currency
        FROM plans
        WHERE active=TRUE
          AND archived_at IS NULL
          AND (effective_from IS NULL OR effective_from<=NOW())
          AND (effective_until IS NULL OR effective_until>NOW())
          AND audience IN('direct','both')
        ORDER BY sort_order,price_minor,name
    `);
    const label = plan => plan.service_type === 'bundle'
        ? 'Jellyfin + Stremio'
        : plan.service_type === 'stremio' ? 'Stremio' : 'Jellyfin';
    const options = plans.rows.map(plan => `<option value="${esc(plan.code)}">${esc(plan.name)} · ${esc(label(plan))} · ${Number(plan.price_minor) === 0 ? 'Free' : esc(plan.currency) + ' ' + (Number(plan.price_minor) / 100).toFixed(2)}</option>`).join('');

    return `${notice(req)}<section class="section"><form class="formPanel" method="post" action="/admin/users/new"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGrid"><div class="formGroup"><label>Username</label><input class="input" name="username" required pattern="[A-Za-z0-9._-]{3,40}" maxlength="40"></div><div class="formGroup"><label>Email</label><input class="input" name="email" type="email" required maxlength="254"></div><div class="formGroup"><label>Display name</label><input class="input" name="displayName" maxlength="100"></div><div class="formGroup"><label>Plan</label><select class="input" name="planCode">${options}</select><div class="inlineHelp">Ignored for Portal only.</div></div></div><div class="formGroup"><label>Provisioning timing</label><select class="input" name="provisioningMode"><option value="immediate">Prepare included services immediately</option><option value="after_activation">Prepare included services after customer activates portal account</option><option value="portal_only">Portal account only — no streaming entitlement</option></select></div><div class="securityNote standalone">The customer receives a one-time activation link and chooses their own portal password. <strong>After activation</strong> avoids creating service access for an account the customer has not yet claimed. <strong>Portal only</strong> creates no subscription.</div><button class="button">Create customer</button></form></section>`;
}

module.exports = { customerCreate };
