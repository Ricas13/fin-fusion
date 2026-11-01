'use strict';

// Plain-language text for customer/revenue integrity findings: what the problem means, whether it fixes itself, and what to check.
// Used by the Discord/email/Telegram alert and the Automation page, so the wording is identical everywhere.
//
// Every finding kind raised anywhere in the code has an entry here (a test scans the source and fails if one is missing).
// `selfHeals` is only true where the automation retries on its own, so the alert can say "only act if it appears again".

const OPEN_CUSTOMER = 'Open the customer';
const RECONCILE = 'use Fix / Reconcile access';

const GUIDANCE = Object.freeze({
    // ---- Access integrity
    primary_server_without_plan: {
        title: 'Jellyfin account with no paid plan',
        meaning: 'This customer still has a main Jellyfin account, but no live paid plan entitles them to it. The expiry job normally removes the account within 30 minutes of a plan ending, so this means that cleanup did not happen (or the plan was cancelled, refunded or removed).',
        action: `${OPEN_CUSTOMER} and look at their plans and payments. If they should still have access (they paid, or you want them kept), fix the plan or add it manually. If not, ${RECONCILE} to remove the account. If it keeps coming back, check that their Jellyfin server is online (Admin → Servers).`
    },
    paid_plan_without_recovery_state: {
        title: 'Paid plan with no Jellyfin account and no retry',
        meaning: 'A customer has a live paid plan but no enabled Jellyfin account, and nothing is scheduled to create one, so it will not fix itself.',
        action: `${OPEN_CUSTOMER} and ${RECONCILE}. If it fails again, check the server they are assigned to is online (Admin → Servers).`
    },
    free_plan_without_ready_server: {
        title: 'Free plan waiting for a server',
        meaning: 'A customer has a Free plan but no Free server has room for them yet.',
        action: 'It fixes itself as soon as a Free server has space. If it stays, free up a slot or add capacity (Admin → Servers).',
        selfHeals: true
    },
    free_server_without_plan: {
        title: 'Free-server account with no Free plan',
        meaning: 'A customer has an account on a Free server but no Free plan behind it.',
        action: `Safe automatic repair removes or re-attaches it. If it is listed again in the next alert, ${OPEN_CUSTOMER.toLowerCase()} and ${RECONCILE}.`,
        selfHeals: true
    },
    unpaid_trial_without_ready_server: {
        title: 'Trial with no working server',
        meaning: 'An unpaid trial has no ready Jellyfin account on its assigned server.',
        action: `Automatic repair re-checks and rolls the trial back. If it is listed again in the next alert, ${OPEN_CUSTOMER.toLowerCase()} and ${RECONCILE}.`,
        selfHeals: true
    },
    free_restore_reprovision_failed: {
        title: 'Restoring Free access failed',
        meaning: 'The system tried to bring a customer back onto the Free server and it did not work.',
        action: `${OPEN_CUSTOMER} and ${RECONCILE}. If it fails again, check the Free server is online (Admin → Servers).`
    },
    stremio_entitlement_without_install_link: {
        title: 'Stremio plan with no install link',
        meaning: 'A customer has a live Stremio subscription but no active install link, so they cannot set Stremio up.',
        action: `${OPEN_CUSTOMER} and ${RECONCILE}; it recreates their private install link.`
    },
    stremio_install_link_not_recoverable: {
        title: "Stremio install link can't be shown again",
        meaning: 'The customer has a Stremio link, but the saved copy needed to show it again on My Access is missing.',
        action: `${OPEN_CUSTOMER}, go to Stremio and rotate the install link. The customer then gets a new link (the old one stops working).`
    },
    stremio_active_without_effective_subscription: {
        title: 'Stremio still switched on after the plan ended',
        meaning: "A customer's Stremio access is still active, but the subscription behind it has ended, been blocked or removed. Reconciliation normally switches it off, so if it is still listed it may need a manual reconcile.",
        action: `${OPEN_CUSTOMER} and check their plans. If they should keep Stremio, fix or add the plan. If not, ${RECONCILE} to switch Stremio off. If it keeps coming back after that, report it: the reconciliation is not turning it off.`
    },
    stremio_external_source_not_playback_ready: {
        title: 'External Stremio source cannot start playback',
        meaning: 'An external Stremio source has content indexed but no saved password, so it cannot start playback sessions.',
        action: 'Reconnect the external source in the Stremio source settings (re-enter its password).'
    },
    stremio_external_index_count_drift: {
        title: 'Stremio catalogue count mismatch (external source)',
        meaning: 'The number of titles indexed for an external Stremio source does not match what the source reports.',
        action: 'It usually corrects itself at the next index refresh. If it stays, re-run the refresh from the Stremio source settings.',
        selfHeals: true
    },
    stremio_managed_index_count_drift: {
        title: 'Stremio catalogue count mismatch (managed library)',
        meaning: 'The number of titles indexed for a managed Stremio library does not match what it should contain.',
        action: 'It usually corrects itself at the next index refresh. If it stays, re-run the refresh from the Stremio source settings.',
        selfHeals: true
    },
    // ---- Revenue / billing integrity
    refunded_permanent_access: {
        title: 'Refunded customer still has Permanent Access',
        meaning: 'A subscription was ended by a refund, but the customer still has Permanent Access, so they keep access for free.',
        action: `${OPEN_CUSTOMER} and revoke Permanent Access if it was not meant to stay.`
    },
    invalid_recurring_provider_reference: {
        title: 'Subscription with an unusable Stripe/PayPal reference',
        meaning: 'A recurring subscription points at a Stripe or PayPal subscription ID that is missing or not valid, so renewals cannot be checked.',
        action: `${OPEN_CUSTOMER}'s billing and relink the provider subscription (Admin → Billing), or end the subscription if it is not real.`
    },
    duplicate_provider_billing_identity: {
        title: 'One Stripe/PayPal subscription attached to several customers',
        meaning: 'The same provider subscription is linked to more than one local subscription, so one payment could give access to the wrong people.',
        action: 'Do not ignore this. Open each customer listed below, check their billing, keep the provider subscription on the right customer and detach it from the others.'
    },
    renewal_service_credit_unsettled: {
        title: 'Stripe invoice with unsettled service credit',
        meaning: 'Service credit was applied at Stripe for an invoice, but the matching days in this system have not been settled.',
        action: `${OPEN_CUSTOMER}'s billing and check the extra days match what was paid, then resolve the payment incident (Admin → Billing).`
    },
    provider_manual_review: {
        title: 'Payment provider action needs a decision',
        meaning: 'A Stripe/PayPal operation could not complete on its own and is waiting for you.',
        action: 'Open Admin → Billing, find the operation marked for manual review and follow the error shown.'
    },
    customer_deletion_stuck: {
        title: 'Customer deletion is stuck',
        meaning: 'A customer deletion started but has not finished after several attempts.',
        action: 'Open Admin → Automation to see the error, fix it (usually a Jellyfin/Stremio server that is offline) and the deletion will continue.'
    },
    jellyfin_creation_intent_stale: {
        title: 'Jellyfin account creation is stuck',
        meaning: 'The system has been trying to create a Jellyfin account and it has not completed.',
        action: `Check the server is online (Admin → Servers); creation retries by itself. If it stays, ${OPEN_CUSTOMER.toLowerCase()} and ${RECONCILE}.`,
        selfHeals: true
    },
    paid_plan_on_free_pool: {
        title: 'A paid plan is using the Free server pool',
        meaning: 'A plan that is not Free is set to use Free servers, so paying customers could be placed on Free capacity.',
        action: "Admin → Plans: change the plan's server class so it uses the right servers."
    },
    customer_access_not_converged: {
        title: "Customer's access is not settling",
        meaning: "The system keeps trying to set up a customer's access and keeps failing.",
        action: `${OPEN_CUSTOMER}, read the error shown, and ${RECONCILE}. Check their server is online (Admin → Servers).`,
        selfHeals: true
    },
    payment_loss_event_without_incident: {
        title: 'Refund or dispute was processed but not recorded',
        meaning: 'A refund, dispute or similar payment event was marked as handled, but no payment incident exists for it.',
        action: "Find the event in your Stripe/PayPal dashboard using the reference below, check the customer's payments and subscription in Admin, and fix any access or payment record by hand if it is wrong. If this repeats, report it."
    },
    payment_event_stale: {
        title: 'A payment event has not been processed',
        meaning: 'A Stripe/PayPal/Plisio event arrived but has not been processed for a while.',
        action: 'It retries by itself. If it stays, open Admin → Automation to see the error (often a provider key or webhook problem).',
        selfHeals: true
    },
    notification_delivery_uncertain: {
        title: 'A notification may not have been delivered',
        meaning: 'The system is not sure an email or message actually reached its recipient.',
        action: 'Check Admin → Notifications and resend it if it was important.'
    },
    jellyfin_admin_authority_violation: {
        title: 'An admin override conflicts with automation',
        meaning: "A setting you changed by hand on a customer's Jellyfin access disagrees with what the automation expects.",
        action: `${OPEN_CUSTOMER}, go to Access and either return the setting to automatic or re-apply your override.`
    },
    jellyfin_duplicate_active_lane: {
        title: 'Customer has two active Jellyfin accounts in one lane',
        meaning: 'A customer has more than one active Jellyfin account for the same service (for example two Premium accounts).',
        action: `${OPEN_CUSTOMER} and disable or delete the extra account, keeping the one on their assigned server.`
    },
    actorless_administrative_hold: {
        title: 'Admin hold with no administrator recorded',
        meaning: 'An access hold exists that was not created by a named administrator, so nobody is accountable for it.',
        action: `${OPEN_CUSTOMER}, go to Access holds and either confirm the hold again under your name or release it.`
    },
    access_hold_summary_drift: {
        title: 'Access hold display out of sync',
        meaning: 'The old summary of a customer\'s hold disagrees with the real hold records.',
        action: `${OPEN_CUSTOMER} and ${RECONCILE} to resync it.`
    }
});

const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Raw ids shortened to their first 8 characters (enough to find a row in the logs, short enough to read).
function shortenIds(text) {
    return String(text || '').replace(UUID, '$1…');
}

function humanise(kind) {
    const words = String(kind || 'integrity issue').replaceAll('_', ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function guidanceFor(kind) {
    const known = GUIDANCE[String(kind || '')];
    if (known) return { ...known, known: true };
    return {
        title: humanise(kind),
        meaning: '',
        action: 'Open Admin → Automation for the details of this check.',
        known: false
    };
}

// Customer-controlled text goes into chat messages: one line, bounded, and unable to ping @everyone / @here.
function safeText(value) {
    return String(value || '').replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/@(everyone|here)/gi, '@\u200b$1').replace(/\s{2,}/g, ' ').trim().slice(0, 120);
}

function customerLabel(customer) {
    if (!customer) return '';
    const name = safeText(customer.display_name);
    const email = safeText(customer.email);
    if (name && email) return `${name} <${email}>`;
    return name || email;
}

function customerUrl(baseUrl, customerId) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    return base && customerId ? `${base}/admin/users/${encodeURIComponent(customerId)}` : '';
}

const MAX_KINDS = 6;
const MAX_PER_KIND = 5;
const MAX_TEXT = 1700;

// One line of finding detail, with long ids shortened and cut at a word boundary.
function compact(text, max) {
    const line = shortenIds(text).replace(/\s+/g, ' ').trim();
    if (line.length <= max) return line;
    const cut = line.slice(0, max);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30))}…`;
}

// findings: [{ kind, id, customerId, detail }]; customers: Map(customerId -> { display_name, email }).
function buildAlert(findings, { customers = new Map(), baseUrl = '' } = {}) {
    const list = Array.isArray(findings) ? findings : [];
    const groups = new Map();
    for (const item of list) {
        const key = String(item.kind || 'unknown');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    const ordered = [...groups.entries()].sort((a, b) => {
        const aHeals = Boolean(GUIDANCE[a[0]]?.selfHeals), bHeals = Boolean(GUIDANCE[b[0]]?.selfHeals);
        return Number(aHeals) - Number(bHeals) || b[1].length - a[1].length;
    });
    const needsAction = ordered.some(([kind]) => !GUIDANCE[kind]?.selfHeals);
    const total = list.length;
    const compose = (kindLimit, perKind) => {
    const blocks = [];
    for (const [kind, items] of ordered.slice(0, kindLimit)) {
        const info = guidanceFor(kind);
        const lines = [`■ ${info.title}${items.length > 1 ? ` (${items.length})` : ''}`];
        if (info.meaning) lines.push(info.meaning);
        lines.push(`What to do: ${info.action}`);
        if (info.selfHeals) lines.push('This usually clears by itself; only act if it appears again in the next alert.');
        const who = [];
        for (const item of items.slice(0, perKind)) {
            const ids = item.customerId ? [item.customerId] : (item.customerIds || []).slice(0, 3);
            const ref = item.id ? ` (ref ${String(item.id).slice(0, 8)})` : '';
            const named = ids.map(id => {
                const label = customerLabel(customers.get(String(id)));
                const link = customerUrl(baseUrl, id);
                return label ? `${label}${link ? ` — ${link}` : ''}` : `customer ${String(id).slice(0, 8)}…`;
            });
            if (named.length && item.customerId) who.push(`• ${named[0]}${ref}`);
            else if (named.length) who.push(`• ${compact(item.detail, 140)}\n  ${named.join('\n  ')}`);
            else who.push(`• ${compact(item.detail, 220)}${ref}`);
        }
        if (items.length > perKind) who.push(`• +${items.length - perKind} more`);
        if (who.length) lines.push(...who);
        blocks.push(lines.join('\n'));
    }
    if (ordered.length > kindLimit) blocks.push(`+${ordered.length - kindLimit} more kind(s) of problem (${ordered.slice(kindLimit).reduce((n, [, g]) => n + g.length, 0)} items) not shown; check the admin dashboard.`);
    const intro = `${total} thing${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} your attention.`;
    return `${intro}\n\n${blocks.join('\n\n')}`;
    };

    const first = guidanceFor(ordered[0]?.[0]);
    const more = ordered.length > 1 ? ` (+${ordered.length - 1} more)` : '';
    const subject = needsAction
        ? `Needs attention: ${first.title}${more}`
        : `Check: ${first.title}${more} (usually clears itself)`;
    // Discord/Telegram show about 1,800 characters: shrink whole items (never cut through a line or link) until it fits.
    let text = '';
    for (const [kindLimit, perKind] of [[MAX_KINDS, MAX_PER_KIND], [MAX_KINDS, 3], [4, 2], [3, 1], [2, 1], [1, 1]]) {
        text = compose(kindLimit, perKind);
        if (text.length <= MAX_TEXT) break;
    }
    if (text.length > MAX_TEXT) {
        // Last resort: drop whole trailing lines, never half a line or link.
        const kept = text.slice(0, MAX_TEXT - 60).split('\n');
        kept.pop();
        text = `${kept.join('\n')}\n…more not shown; check the admin dashboard.`;
    }

    // A single customer across every finding gets an "Open customer" button.
    const customerIds = [...new Set(list.map(item => String(item.customerId || '')).filter(Boolean))];
    return { subject, text, needsAction, customerIds, singleCustomerId: customerIds.length === 1 ? customerIds[0] : null };
}

// One short line for job logs / the Automation page warning.
function warningLine(findings) {
    const list = Array.isArray(findings) ? findings : [];
    const titles = [...new Set(list.map(item => guidanceFor(item.kind).title))];
    return `${list.length} customer/revenue integrity issue${list.length === 1 ? '' : 's'}: ${titles.slice(0, 4).join('; ')}${titles.length > 4 ? `; +${titles.length - 4} more` : ''}`.slice(0, 1000);
}

module.exports = { GUIDANCE, UUID, shortenIds, humanise, guidanceFor, customerLabel, customerUrl, buildAlert, warningLine, MAX_KINDS, MAX_PER_KIND };
