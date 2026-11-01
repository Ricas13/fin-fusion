'use strict';

// "This plan is full. Add anyway?" Shown when an administrator action is refused only because the plan or its
// servers are at capacity. Nothing has been changed yet. Confirming re-submits the SAME form (every original
// field, carried as hidden inputs) with the capacity override switched on; cancelling goes back untouched.

const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');

const RESERVED = new Set(['_csrf', 'allowOverCapacity']);

function hiddenFields(body = {}) {
    return Object.entries(body)
        .filter(([key, value]) => !RESERVED.has(key) && (typeof value === 'string' || typeof value === 'number'))
        .map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`)
        .join('');
}

function isCapacityRefusal(error) {
    return error?.code === 'PLAN_CAPACITY_EXHAUSTED';
}

// customer: { id, name }. what: a short phrase such as "grant this plan" or "move this subscription".
function confirmPage(req, { customer, message, what, actionPath, backHref }) {
    const body = `<section class="section"><div class="sectionHead"><div><h2>This plan is full</h2><div class="muted">${esc(customer.name)}</div></div><a class="button secondary" href="${esc(backHref)}">Back to customer</a></div>
<div class="sectionBody" data-capacity-confirm>
<div class="notice warn"><strong>${esc(message)}</strong> Nothing has been changed yet.</div>
<p>As an administrator you can ${esc(what)} anyway. The customer gets the real plan, so expiry, renewals and inactivity are managed by automation as normal, and the override is recorded in the audit log. If every server for the plan is full, the customer is not placed on a server automatically: use <em>Add to server</em> (or <em>Move server</em> if they already have an account) on their Jellyfin card afterwards.</p>
<form method="post" action="${esc(actionPath)}" data-native-submit="true">
<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">${hiddenFields(req.body)}<input type="hidden" name="allowOverCapacity" value="1">
<div class="buttonRow"><button class="button" type="submit">Yes, ${esc(what)} anyway</button><a class="button secondary" href="${esc(backHref)}">Cancel</a></div>
</form></div></section>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'users', title: 'This plan is full', subtitle: customer.name, body });
}

module.exports = { confirmPage, isCapacityRefusal, hiddenFields };
