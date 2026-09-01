'use strict';

const discordMessage = require('./discord-message');
const { humanizeEventType, formatDate, formatAmount } = require('./notification-templates');

function clean(value, max = 500) {
    return String(value ?? '').trim().slice(0, max);
}

function compact(parts) {
    return parts.map(part => clean(part, 800)).filter(Boolean);
}

function tone(eventType, emailSpec) {
    if (/support\./i.test(eventType)) return 'info';
    if (/payment\.received|subscription\.activated|service\.provisioned|claim\.completed|customer\.claimed|discount\.redeemed|plan_change\.applied/i.test(eventType)) return 'success';
    if (/pending|expir|warning|attention|scheduled|capacity|renewal_failed/i.test(eventType) || emailSpec?.tone === 'warn') return 'warn';
    if (/failed|offline|suspended|disabled|removed|inactive|expired|chargeback|disput|error|security/i.test(eventType) || emailSpec?.tone === 'bad') return 'bad';
    return 'info';
}

function icon(eventType, messageTone) {
    if (/support\./i.test(eventType)) return '💬';
    if (/server\.offline/i.test(eventType)) return '🔴';
    if (/discount\.redeemed/i.test(eventType)) return '🏷️';
    if (messageTone === 'success') return '✅';
    if (messageTone === 'warn') return '⚠️';
    if (messageTone === 'bad') return '⛔';
    return 'ℹ️';
}

function markdownName(value) {
    return clean(value, 100).replace(/([\\`*_~|>])/g, '\\$1');
}

function isAccessRemoval(eventType) {
    return /access\.(removed|disabled)|service\.(disabled|inactive|expired)|subscription\.disabled/i.test(eventType);
}

function customerDescription(eventType, payload, emailSpec, fallbackText) {
    if (eventType === 'customer.service.provisioned') {
        const service = clean(payload.service || 'Your service', 80);
        return `${service} access has been created and is ready to use.`;
    }
    if (eventType === 'payment.received') {
        const who = markdownName(payload.customerName);
        const plan = markdownName(payload.planName);
        return `${who ? `Thanks, **${who}**! ` : ''}Your payment has been received successfully${plan ? ` for **${plan}**` : ''}.`;
    }
    if (eventType === 'subscription.activated') {
        const plan = markdownName(payload.planName);
        return `${plan ? `Your **${plan}** subscription` : 'Your subscription'} is active and ready to use.`;
    }
    if (eventType === 'subscription.expiring') {
        const plan = clean(payload.planName || 'access', 160);
        const date = formatDate(payload.expiresOn);
        const autoRenew = payload.autoRenewal === true ? ' Auto-renew is on.' : payload.autoRenewal === false ? ' Auto-renew is off.' : '';
        return `Your ${plan} is due to expire${date ? ` on ${date}` : ' soon'}.${autoRenew}`;
    }
    if (isAccessRemoval(eventType)) {
        const where = compact([payload.service, payload.serverName]).join(' · ') || 'service';
        return `Your ${where} access has been disabled.`;
    }
    return clean(emailSpec?.text || fallbackText || 'There is an update to your account.', 1800);
}

function addField(rows, seen, label, value, inline = false) {
    const name = clean(label, 220);
    const text = clean(value, 900);
    const key = name.toLowerCase();
    if (!name || !text || seen.has(key)) return;
    seen.add(key);
    rows.push({ name, value: text, inline });
}

function customerFields(payload, emailSpec) {
    const rows = [];
    const seen = new Set();
    for (const row of emailSpec?.facts || []) {
        const inline = ['Plan', 'Amount', 'Date', 'Username'].includes(row.label);
        addField(rows, seen, row.label, row.value, inline);
    }
    addField(rows, seen, 'Service', payload.service, true);
    addField(rows, seen, 'Payment provider', payload.provider, true);
    addField(rows, seen, 'Reason', payload.reason, false);
    return rows.slice(0, 8);
}

function adminFields(payload, emailSpec = {}) {
    const rows = [];
    const seen = new Set();
    for (const row of emailSpec?.facts || []) {
        const inline = ['User', 'Plan', 'Amount', 'Server', 'Status', 'Provider', 'Priority', 'Ticket ID', 'IP'].includes(row.label);
        addField(rows, seen, row.label, row.value, inline);
    }
    if (!seen.has('user')) addField(rows, seen, 'User', payload.customerName || payload.email, true);
    addField(rows, seen, 'Plan', payload.planName, true);
    addField(rows, seen, 'Amount', formatAmount(payload.amount, payload.currency), true);
    addField(rows, seen, 'Server', payload.serverName || payload.serverUrl, true);
    addField(rows, seen, 'Status', payload.status || payload.serverStatus, true);
    addField(rows, seen, 'Ticket title', payload.ticketTitle || payload.ticketSubject, false);
    addField(rows, seen, 'Content', payload.ticketContent || payload.content, false);
    addField(rows, seen, 'Provider', payload.provider || payload.source, true);
    addField(rows, seen, 'Reason', payload.reason, false);
    addField(rows, seen, 'IP', payload.ip, true);
    return rows.slice(0, 12);
}

function render({ eventType, payload = {}, emailSpec = {}, subject = '', text = '', audience = 'customer' } = {}) {
    const safeEventType = clean(eventType, 160);
    const admin = audience === 'admin';
    const messageTone = tone(safeEventType, emailSpec);
    const titleText = admin
        ? clean(emailSpec.title || emailSpec.subject || subject, 220) || humanizeEventType(safeEventType)
        : clean(emailSpec.title || emailSpec.subject || subject, 220) || humanizeEventType(safeEventType);
    const description = admin
        ? clean(emailSpec.text || text, 1800) || 'An account or platform event needs attention.'
        : customerDescription(safeEventType, payload, emailSpec, text);
    const actionUrl = admin ? clean(emailSpec.actionUrl || payload.ticketUrl || payload.adminUrl, 1000) : clean(emailSpec.actionUrl, 1000);
    const actionLabel = admin ? clean(emailSpec.actionLabel || (payload.ticketUrl ? 'Open ticket' : 'Open customer'), 80) : clean(emailSpec.actionLabel || 'Open your account', 80);
    const eventLabel = admin
        ? clean(emailSpec.eventLabel, 180) || humanizeEventType(safeEventType)
        : clean(emailSpec.eventLabel, 180) || humanizeEventType(safeEventType);
    return discordMessage.card({
        title: `${icon(safeEventType, messageTone)} ${titleText}`,
        description,
        tone: messageTone,
        fields: admin ? adminFields(payload, emailSpec) : customerFields(payload, emailSpec),
        url: actionUrl,
        footer: `CAPTAiN FiN • ${eventLabel}`,
        buttonLabel: actionUrl ? actionLabel : '',
        buttonUrl: actionUrl
    });
}

module.exports = { render, tone, customerFields, adminFields };