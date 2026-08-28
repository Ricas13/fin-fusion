'use strict';

function clean(value, max = 500) {
    return String(value ?? '').trim().slice(0, max);
}

function compact(parts) {
    return parts.map(part => clean(part, 800)).filter(Boolean);
}

function humanizeEventType(eventType) {
    const value = clean(eventType, 160);
    if (!value) return 'Account notification';
    return value
        .split('.')
        .map(part => part.replace(/[_-]+/g, ' '))
        .join(' · ')
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatDate(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return clean(value, 80);
    return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC'
    }).format(date);
}

function formatAmount(amount, currency) {
    if (amount === null || amount === undefined || amount === '') return '';
    const numeric = Number(amount);
    const code = clean(currency || 'GBP', 8).toUpperCase();
    if (!Number.isFinite(numeric)) return compact([clean(amount, 60), code]).join(' ');
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).format(numeric);
    } catch (_) {
        return `${numeric.toFixed(2)} ${code}`;
    }
}

function firstHttpUrl(text) {
    const match = clean(text, 12000).match(/https?:\/\/[^\s<>]+/i);
    return match ? match[0].replace(/[),.;]+$/, '') : '';
}

function enrichLegacyPayload(eventType, payload, fallback) {
    const enriched = { ...(payload || {}) };
    const subject = clean(fallback.subject, 500);
    const text = clean(fallback.text, 12000);
    const combined = `${subject} ${text}`;

    if (eventType === 'customer.service.provisioned') {
        if (!enriched.service) {
            if (/jellyfin/i.test(combined)) enriched.service = 'Jellyfin';
            else if (/stremio/i.test(combined)) enriched.service = 'Stremio';
        }
        if (!enriched.serverUrl && String(enriched.service || '').toLowerCase() === 'jellyfin') enriched.serverUrl = firstHttpUrl(text);
        if (!enriched.jellyfinUsername) {
            const username = text.match(/sign in as\s+([^.,]+?)(?:\.|,| and |$)/i);
            if (username) enriched.jellyfinUsername = clean(username[1], 160);
        }
        if (enriched.passwordSetupRequired === undefined && /choose your jellyfin password|set your jellyfin password/i.test(text)) enriched.passwordSetupRequired = true;
    }

    if (eventType === 'payment.received' || eventType === 'payment.failed') {
        if (enriched.amount === undefined || !enriched.currency) {
            const amount = text.match(/\b([A-Z]{3})\s+([0-9]+(?:[.,][0-9]{1,2})?)\b/);
            if (amount) {
                if (!enriched.currency) enriched.currency = amount[1];
                if (enriched.amount === undefined) enriched.amount = Number(amount[2].replace(',', '.'));
            }
        }
        if (!enriched.planName && eventType === 'payment.received') {
            const plan = text.match(/(?:payment (?:was )?confirmed|confirmed payment) for\s+(.+?)(?:\s+via\s+|\.|$)/i);
            if (plan) enriched.planName = clean(plan[1], 200);
        }
        if (!enriched.provider) {
            const provider = text.match(/\bvia\s+([A-Za-z0-9_-]+)/i) || text.match(/Your\s+([A-Za-z0-9_-]+)\s+renewal payment/i);
            if (provider) enriched.provider = clean(provider[1], 80);
        }
    }

    if (eventType === 'customer.service.inactive') {
        if (!enriched.reason) enriched.reason = 'inactivity';
        if (!enriched.service && /jellyfin/i.test(combined)) enriched.service = 'Jellyfin';
    } else if (eventType === 'customer.service.expired') {
        if (!enriched.reason) enriched.reason = 'expired';
    }

    return enriched;
}

function accountAction(payload) {
    const accountUrl = clean(payload.accountUrl, 1000);
    return accountUrl ? { actionLabel: 'Open your account', actionUrl: accountUrl } : {};
}

function facts(payload, nextStep = '') {
    const rows = [];
    if (payload.planName) rows.push({ label: 'Plan', value: payload.planName });
    if (payload.expiresOn) rows.push({ label: 'Date', value: formatDate(payload.expiresOn) });
    const amount = formatAmount(payload.amount, payload.currency);
    if (amount) rows.push({ label: 'Amount', value: amount });
    if (nextStep) rows.push({ label: 'Next step', value: nextStep });
    return rows;
}

function customerProvisioned(payload, fallback) {
    const service = clean(payload.service || 'service', 80);
    const lower = service.toLowerCase();
    const jellyfin = lower.includes('jellyfin');
    const stremio = lower.includes('stremio');
    const title = jellyfin ? 'Your Jellyfin access is ready' : stremio ? 'Your Stremio access is ready' : `${service} access is ready`;
    const body = jellyfin
        ? compact([
            payload.serverUrl ? `Server: ${payload.serverUrl}` : '',
            payload.jellyfinUsername ? `Username: ${payload.jellyfinUsername}` : '',
            payload.passwordSetupRequired ? 'Set or view your Jellyfin password securely in your account portal.' : '',
            'You can manage your access from your account portal.'
        ]).join('\n\n')
        : stremio
            ? 'Install or reconnect Stremio from the Stremio section of your account portal.'
            : clean(fallback.text, 12000) || 'Your service access is ready.';
    const server = compact([payload.serverName, payload.serverUrl]).join(' · ');
    const chatFacts = compact([
        server,
        payload.jellyfinUsername ? `user ${payload.jellyfinUsername}` : '',
        payload.accountUrl
    ]);
    const chat = `✅ ${title}${chatFacts.length ? ` — ${chatFacts.join(' · ')}` : ''}`;
    const nextStep = jellyfin && payload.passwordSetupRequired
        ? 'Set or view your password in your account portal'
        : stremio ? 'Install Stremio from your account portal' : 'Open your account portal';
    const provisionFacts = facts(payload, nextStep);
    if (payload.serverUrl) provisionFacts.unshift({ label: 'Server', value: compact([payload.serverName, payload.serverUrl]).join(' · ') });
    if (payload.jellyfinUsername) provisionFacts.splice(payload.serverUrl ? 1 : 0, 0, { label: 'Username', value: payload.jellyfinUsername });
    return {
        email: {
            subject: clean(fallback.subject, 300) || title,
            title,
            text: body,
            eventLabel: 'Service ready',
            tone: 'default',
            facts: provisionFacts,
            ...accountAction(payload)
        },
        chat
    };
}

function subscriptionExpiring(payload, fallback) {
    const date = formatDate(payload.expiresOn);
    const autoRenew = payload.autoRenewal === true ? 'Auto-renew is on.' : payload.autoRenewal === false ? 'Auto-renew is off.' : '';
    const title = 'Your access is expiring soon';
    const body = compact([
        payload.planName ? `Your ${payload.planName} access is due to expire${date ? ` on ${date}` : ''}.` : `Your access is due to expire${date ? ` on ${date}` : ''}.`,
        autoRenew,
        payload.autoRenewal === true ? 'No action is needed if your renewal completes normally.' : 'Open your account to review renewal or access options.'
    ]).join('\n\n');
    const chat = `⚠️ ${payload.planName || 'Access'} expires${date ? ` ${date}` : ' soon'}${autoRenew ? ` · ${autoRenew}` : ''}${payload.accountUrl ? ` · ${payload.accountUrl}` : ''}`;
    const nextStep = payload.autoRenewal === true ? 'No action unless your renewal fails' : 'Review renewal or access options';
    return {
        email: {
            subject: clean(fallback.subject, 300) || title,
            title,
            text: body,
            eventLabel: 'Subscription reminder',
            tone: 'warn',
            facts: facts(payload, nextStep),
            ...accountAction(payload)
        },
        chat
    };
}

function accessRemoved(payload, fallback) {
    const reason = clean(payload.reason || 'admin', 120);
    const title = 'Your service access has been disabled';
    const where = compact([payload.service, payload.serverName]).join(' · ');
    const body = compact([
        `Access${where ? ` to ${where}` : ''} has been disabled.`,
        `Reason: ${reason}.`,
        'Open your account to review your current plan and next steps.'
    ]).join('\n\n');
    const chat = `⛔ Access disabled${where ? ` — ${where}` : ''} · ${reason}${payload.accountUrl ? ` · ${payload.accountUrl}` : ''}`;
    return {
        email: {
            subject: clean(fallback.subject, 300) || title,
            title,
            text: body,
            eventLabel: 'Access update',
            tone: 'bad',
            facts: facts(payload, 'Review your account and access options'),
            ...accountAction(payload)
        },
        chat
    };
}

function paymentReceived(payload, fallback) {
    const amount = formatAmount(payload.amount, payload.currency);
    const title = 'Payment received';
    const body = compact([
        amount ? `We received your payment of ${amount}.` : clean(fallback.text, 12000) || 'We received your payment.',
        payload.planName ? `Plan: ${payload.planName}.` : '',
        payload.provider ? `Payment provider: ${payload.provider}.` : ''
    ]).join('\n\n');
    const chat = `✅ Payment received${amount ? ` — ${amount}` : ''}${payload.planName ? ` · ${payload.planName}` : ''}${payload.accountUrl ? ` · ${payload.accountUrl}` : ''}`;
    return {
        email: {
            subject: clean(fallback.subject, 300) || title,
            title,
            text: body,
            eventLabel: 'Payment confirmation',
            tone: 'default',
            facts: facts(payload, 'No action is required'),
            ...accountAction(payload)
        },
        chat
    };
}

function paymentFailed(payload, fallback) {
    const amount = formatAmount(payload.amount, payload.currency);
    const title = 'Payment needs attention';
    const body = compact([
        amount ? `We could not complete your payment of ${amount}.` : clean(fallback.text, 12000) || 'We could not complete your payment.',
        payload.planName ? `Plan: ${payload.planName}.` : '',
        payload.reason ? `Reason: ${payload.reason}.` : '',
        'Open your account to review your payment or renewal options.'
    ]).join('\n\n');
    const chat = `⚠️ Payment failed${amount ? ` — ${amount}` : ''}${payload.planName ? ` · ${payload.planName}` : ''}${payload.accountUrl ? ` · ${payload.accountUrl}` : ''}`;
    return {
        email: {
            subject: clean(fallback.subject, 300) || title,
            title,
            text: body,
            eventLabel: 'Payment attention required',
            tone: 'bad',
            facts: facts(payload, 'Review payment or renewal options'),
            ...accountAction(payload)
        },
        chat
    };
}

function genericTemplate(eventType, payload, fallback) {
    const subject = clean(fallback.subject, 300) || humanizeEventType(eventType);
    const text = clean(fallback.text, 12000) || 'There is an update to your account.';
    const chatText = clean(text.replace(/\s+/g, ' '), 700);
    const chat = `ℹ️ ${subject}${chatText ? ` — ${chatText}` : ''}${payload.accountUrl ? ` · ${payload.accountUrl}` : ''}`;
    return {
        email: {
            subject,
            title: subject,
            text,
            eventLabel: humanizeEventType(eventType),
            tone: /failed|disabled|removed|chargeback|disput/i.test(eventType) ? 'bad' : /expir|warning|attention/i.test(eventType) ? 'warn' : 'default',
            facts: facts(payload, ''),
            ...accountAction(payload)
        },
        chat
    };
}

function isAccessRemoval(eventType) {
    return /access\.(removed|disabled)|service\.(disabled|inactive|expired)|subscription\.disabled/i.test(eventType);
}

function adminLine(eventType, payload, fallback) {
    const who = clean(payload.customerName || payload.email || 'Customer', 160);
    const link = clean(payload.adminUrl, 1000);
    if (isAccessRemoval(eventType)) {
        const object = clean(payload.service || payload.planName || 'access', 120);
        const where = clean(payload.serverName, 160);
        const because = clean(payload.reason, 180);
        return compact([
            `${who} removed from ${where || object}`,
            because ? `— ${because}${payload.planName && payload.planName !== object ? ` (${payload.planName})` : ''}.` : '',
            link
        ]).join(' ');
    }
    if (eventType === 'payment.received' || eventType === 'payment.failed') {
        const verb = eventType === 'payment.received' ? 'paid' : 'payment failed';
        const amount = formatAmount(payload.amount, payload.currency);
        const object = compact([amount, payload.planName]).join(' · ');
        const because = clean(payload.reason, 160);
        return compact([
            `${who} ${verb}${object ? ` ${object}` : ''}`,
            payload.provider ? `via ${payload.provider}` : '',
            because ? `— ${because}` : '',
            link
        ]).join(' ');
    }
    const subject = clean(fallback.subject, 220) || humanizeEventType(eventType);
    const detail = clean(fallback.text, 500).replace(/\s+/g, ' ');
    return compact([`${who} — ${subject}`, detail, link]).join(' · ');
}

function resolveTemplate(eventType, payload, fallback) {
    if (eventType === 'customer.service.provisioned') return customerProvisioned(payload, fallback);
    if (eventType === 'subscription.expiring') return subscriptionExpiring(payload, fallback);
    if (eventType === 'payment.received') return paymentReceived(payload, fallback);
    if (eventType === 'payment.failed') return paymentFailed(payload, fallback);
    if (isAccessRemoval(eventType)) return accessRemoved(payload, fallback);
    return genericTemplate(eventType, payload, fallback);
}

function renderNotification({ eventType, payload = {}, subject = '', text = '', audience = 'customer' } = {}) {
    const safeEventType = clean(eventType, 160);
    const fallback = { subject, text };
    const enrichedPayload = enrichLegacyPayload(safeEventType, payload || {}, fallback);
    const resolved = resolveTemplate(safeEventType, enrichedPayload, fallback);
    const customerChat = clean(resolved.chat, 3500);
    const adminChat = clean(adminLine(safeEventType, enrichedPayload, fallback), 3500);
    const chat = audience === 'admin' ? adminChat : customerChat;
    return {
        email: {
            ...resolved.email,
            payload: enrichedPayload
        },
        discord: chat,
        telegram: chat,
        whatsapp: chat
    };
}

module.exports = {
    renderNotification,
    enrichLegacyPayload,
    humanizeEventType,
    formatDate,
    formatAmount
};
