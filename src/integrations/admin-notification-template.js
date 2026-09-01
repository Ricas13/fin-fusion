'use strict';

const { enrichLegacyPayload, humanizeEventType, formatDate, formatAmount } = require('./notification-templates');

function clean(value, max = 500) {
    return String(value ?? '').trim().slice(0, max);
}

function first(...values) {
    for (const value of values) {
        const text = clean(value, 4000);
        if (text) return text;
    }
    return '';
}

function oneLine(value, max = 900) {
    return clean(value, max).replace(/\s+/g, ' ');
}

function addFact(rows, seen, label, value) {
    const safeLabel = clean(label, 120);
    const safeValue = clean(value, 1000);
    const key = safeLabel.toLowerCase();
    if (!safeLabel || !safeValue || seen.has(key)) return;
    seen.add(key);
    rows.push({ label: safeLabel, value: safeValue });
}

function parseMoney(text) {
    const match = clean(text, 12000).match(/\b([A-Z]{3})\s+([0-9]+(?:[.,][0-9]{1,2})?)\b/);
    if (!match) return {};
    return { currency: match[1], amount: Number(match[2].replace(',', '.')) };
}

function enrichAdminPayload(eventType, payload, fallback) {
    const enriched = enrichLegacyPayload(eventType, payload || {}, fallback || {});
    const subject = clean(fallback?.subject, 500);
    const text = clean(fallback?.text, 12000);
    const combined = `${subject} ${text}`;

    if (/^payment\./.test(eventType) && (enriched.amount === undefined || !enriched.currency)) {
        const parsed = parseMoney(combined);
        if (enriched.amount === undefined && parsed.amount !== undefined) enriched.amount = parsed.amount;
        if (!enriched.currency && parsed.currency) enriched.currency = parsed.currency;
    }
    if (!enriched.provider && /^payment\./.test(eventType)) {
        const provider = combined.match(/\b(?:via|from)\s+([A-Za-z0-9_-]+)/i) || combined.match(/^([A-Za-z0-9_-]+)\s+(?:confirmed|reported|recorded)/i);
        if (provider) enriched.provider = clean(provider[1], 80);
    }
    if (!enriched.planName) {
        if (eventType === 'payment.received') {
            const match = text.match(/payment confirmed for\s+(.+?)\s+[—-]\s+(.+?)(?:\s+via\s+|\.|$)/i)
                || text.match(/(?:payment (?:was )?confirmed|confirmed payment) for\s+(.+?)(?:\s+via\s+|\.|$)/i);
            if (match) enriched.planName = clean(match[2] || match[1], 200);
        } else if (eventType === 'subscription.activated') {
            const match = subject.match(/^(.+?)\s+activated$/i) || text.match(/\bactivated\s+(.+?)(?:\.|$)/i);
            if (match) enriched.planName = clean(match[1], 200);
        }
    }
    if (eventType === 'server.offline') {
        if (!enriched.serverName) {
            const match = subject.match(/server offline:\s*(.+)$/i) || text.match(/^(.+?)\s+has crossed the health threshold/i);
            if (match) enriched.serverName = clean(match[1], 200);
        }
        if (!enriched.status) enriched.status = 'Offline';
    }
    if (eventType === 'subscription.activated' && !enriched.status) enriched.status = 'Active';
    if (eventType === 'customer.service.provisioned' && !enriched.status) enriched.status = 'Provisioned';
    if (eventType === 'customer.access.suspended' && !enriched.status) enriched.status = 'Suspended';
    if (/customer\.access\.(removed|disabled)|customer\.service\.(inactive|expired)/.test(eventType) && !enriched.status) {
        enriched.status = eventType.endsWith('.expired') ? 'Expired' : eventType.endsWith('.inactive') ? 'Disabled' : 'Removed';
    }
    return enriched;
}

function titleFor(eventType, fallbackSubject) {
    const titles = {
        'payment.received': 'Payment received',
        'payment.renewal_failed': 'Renewal failed',
        'subscription.activated': 'Subscription activated',
        'subscription.expiring': 'Subscription expiring soon',
        'customer.service.provisioned': 'Customer access provisioned',
        'customer.access.suspended': 'Customer access suspended',
        'customer.access.removed': 'Customer access removed',
        'customer.access.disabled': 'Customer access removed',
        'customer.service.inactive': 'Customer access suspended',
        'customer.service.expired': 'Customer access removed',
        'server.offline': 'Server offline',
        'commercial.discount.redeemed': 'Discount redeemed',
        'customer.claimed': 'Imported account claimed',
        'support.ticket.needs_staff': 'New support ticket',
        'login.customer.succeeded': 'Customer signed in'
    };
    return titles[eventType] || clean(fallbackSubject, 300) || humanizeEventType(eventType);
}

function toneFor(eventType) {
    if (/payment\.received|subscription\.activated|service\.provisioned|discount\.redeemed|customer\.claimed/.test(eventType)) return 'default';
    if (/renewal_failed|expiring/.test(eventType)) return 'warn';
    if (/offline|suspended|removed|disabled|inactive|expired|failed|chargeback|disput/.test(eventType)) return 'bad';
    return 'default';
}

function factsFor(eventType, payload) {
    const rows = [];
    const seen = new Set();
    const user = first(payload.customerName, payload.userName, payload.name, payload.customerEmail, payload.email);
    const plan = first(payload.planName, payload.plan, payload.productName);
    const amount = formatAmount(payload.amount, payload.currency);
    const server = first(payload.serverName, payload.server, payload.jellyfinServerName, payload.serverUrl);
    const status = first(payload.status, payload.serverStatus);
    const ticketTitle = first(payload.ticketTitle, payload.ticketSubject);
    const content = oneLine(first(payload.ticketContent, payload.content), 900);

    addFact(rows, seen, 'User', user);
    addFact(rows, seen, 'Plan', plan);
    addFact(rows, seen, 'Amount', amount);
    addFact(rows, seen, 'Server', server);
    addFact(rows, seen, 'Status', status);
    addFact(rows, seen, 'Ticket title', ticketTitle);
    addFact(rows, seen, 'Content', content);

    if (payload.expiresOn) addFact(rows, seen, 'Date', formatDate(payload.expiresOn));
    addFact(rows, seen, 'Provider', first(payload.provider, payload.source));
    addFact(rows, seen, 'Reason', payload.reason);
    addFact(rows, seen, 'Category', payload.category);
    addFact(rows, seen, 'Priority', payload.priority);
    addFact(rows, seen, 'Ticket ID', first(payload.ticketNumber, payload.ticketId));
    if (eventType === 'login.customer.succeeded') addFact(rows, seen, 'IP', payload.ip);
    return rows.slice(0, 12);
}

function summaryFor(eventType, payload, fallbackText) {
    const user = first(payload.customerName, payload.email, 'Customer');
    const plan = first(payload.planName, payload.plan, payload.productName);
    const server = first(payload.serverName, payload.server, payload.jellyfinServerName);
    const amount = formatAmount(payload.amount, payload.currency);
    switch (eventType) {
        case 'payment.received': return `${user} completed a payment${amount ? ` of ${amount}` : ''}${plan ? ` for ${plan}` : ''}.`;
        case 'payment.renewal_failed': return `${user}'s renewal${plan ? ` for ${plan}` : ''} failed${amount ? ` (${amount})` : ''}.`;
        case 'subscription.activated': return `${user}'s${plan ? ` ${plan}` : ''} subscription is active.`;
        case 'subscription.expiring': return `${user}'s${plan ? ` ${plan}` : ''} subscription is approaching expiry.`;
        case 'customer.service.provisioned': return `${user}'s access${server ? ` on ${server}` : ''} has been provisioned.`;
        case 'customer.access.suspended':
        case 'customer.service.inactive': return `${user}'s access${server ? ` on ${server}` : ''} is suspended.`;
        case 'customer.access.removed':
        case 'customer.access.disabled':
        case 'customer.service.expired': return `${user}'s access${server ? ` on ${server}` : ''} has been removed.`;
        case 'server.offline': return `${server || 'A Jellyfin server'} is offline.`;
        case 'commercial.discount.redeemed': return `${user} redeemed a discount${plan ? ` for ${plan}` : ''}.`;
        case 'customer.claimed': return `${user} claimed an imported account.`;
        case 'support.ticket.needs_staff': return `${user} needs staff attention on a support ticket.`;
        case 'login.customer.succeeded': return `${user} signed in to the customer portal.`;
        default: return clean(fallbackText, 12000) || 'An account or platform event was recorded.';
    }
}

function chatLine(title, facts, actionUrl) {
    const details = facts.slice(0, 7).map(row => `${row.label}: ${oneLine(row.value, 220)}`);
    return clean([title, ...details, actionUrl].filter(Boolean).join(' · '), 3500);
}

function renderAdminNotification({ eventType, payload = {}, subject = '', text = '' } = {}) {
    const safeEventType = clean(eventType, 160);
    const fallback = { subject, text };
    const enrichedPayload = enrichAdminPayload(safeEventType, payload, fallback);
    const title = titleFor(safeEventType, subject);
    const body = summaryFor(safeEventType, enrichedPayload, text);
    const factRows = factsFor(safeEventType, enrichedPayload);
    const actionUrl = first(enrichedPayload.ticketUrl, enrichedPayload.adminUrl);
    const actionLabel = safeEventType === 'support.ticket.needs_staff' && enrichedPayload.ticketUrl ? 'Open ticket' : actionUrl ? 'Open customer' : '';
    const email = {
        subject: title,
        title,
        text: body,
        eventLabel: humanizeEventType(safeEventType),
        tone: toneFor(safeEventType),
        facts: factRows,
        actionLabel,
        actionUrl,
        payload: enrichedPayload
    };
    const chat = chatLine(title, factRows, actionUrl);
    return { email, discord: chat, telegram: chat, whatsapp: chat };
}

module.exports = { renderAdminNotification, enrichAdminPayload, factsFor, titleFor };
