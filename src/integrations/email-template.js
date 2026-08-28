'use strict';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Kept for backwards-compatible callers. Transactional CTAs no longer use URLs
// discovered inside message text.
function firstUrl(text) {
    const match = String(text || '').match(/https?:\/\/[^\s<>]+/i);
    if (!match) return '';
    return match[0].replace(/[),.;]+$/, '');
}

function paragraphHtml(text) {
    return String(text || '')
        .split(/\n{2,}/)
        .map(block => block.trim())
        .filter(Boolean)
        .map(block => `<p style="margin:0 0 18px;color:#475569;font-size:15px;line-height:1.7;">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

function humanizeEventType(eventType) {
    const value = String(eventType || '').trim();
    if (!value) return 'Account notification';
    return value
        .split('.')
        .map(part => part.replace(/[_-]+/g, ' '))
        .join(' · ')
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function eventLabel(eventType) {
    const labels = {
        'customer.service.provisioned': 'Service ready',
        'customer.access.removed': 'Access update',
        'customer.access.disabled': 'Access update',
        'customer.registered': 'Customer registered',
        'customer.trial.started': 'Trial started',
        'customer.claim.completed': 'Claim completed',
        'payment.failed': 'Payment attention required',
        'payment.received': 'Payment confirmation',
        'payment.chargeback': 'Payment dispute',
        'payment.disputed': 'Payment dispute',
        'subscription.activated': 'Subscription active',
        'subscription.expiring': 'Subscription reminder',
        'subscription.cancelled': 'Subscription update',
        'subscription.plan_change.requires_checkout': 'Plan change action required'
    };
    return labels[eventType] || humanizeEventType(eventType);
}

function formatDate(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
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
    const code = String(currency || 'GBP').trim().toUpperCase();
    if (!Number.isFinite(numeric)) return `${amount} ${code}`.trim();
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(numeric);
    } catch (_) {
        return `${numeric.toFixed(2)} ${code}`;
    }
}

function normalizedFacts(payload = {}, suppliedFacts = [], nextStep = '') {
    const rows = [];
    const seen = new Set();
    const add = (label, value) => {
        const safeLabel = String(label || '').trim();
        const safeValue = String(value ?? '').trim();
        if (!safeLabel || !safeValue || seen.has(safeLabel.toLowerCase())) return;
        seen.add(safeLabel.toLowerCase());
        rows.push({ label: safeLabel, value: safeValue });
    };
    for (const row of Array.isArray(suppliedFacts) ? suppliedFacts : []) add(row?.label, row?.value);
    add('Plan', payload.planName);
    add('Date', formatDate(payload.expiresOn));
    add('Amount', formatAmount(payload.amount, payload.currency));
    add('Next step', nextStep || payload.nextStep);
    return rows.slice(0, 8);
}

function factTableHtml(rows) {
    if (!rows.length) return '';
    const body = rows.map(row => `<tr><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;width:34%;">${escapeHtml(row.label)}</td><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:14px;font-weight:600;">${escapeHtml(row.value)}</td></tr>`).join('');
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 6px;border:1px solid #e2e8f0;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">${body}</table>`;
}

function toneColour(tone) {
    if (tone === 'warn') return '#d97706';
    if (tone === 'bad') return '#991b1b';
    return '#1e3a5f';
}

function renderProfessionalEmail({
    subject,
    text,
    title = '',
    preheader = '',
    eventType = '',
    eventLabel: explicitEventLabel = '',
    actionLabel = '',
    actionUrl = '',
    payload = {},
    facts = [],
    nextStep = '',
    tone = 'default',
    siteName = 'CAPTAiNFiN',
    publicBaseUrl = '',
    transactional = true,
    unsubscribeUrl = ''
}) {
    const safeSiteName = escapeHtml(siteName || 'CAPTAiNFiN');
    const heading = title || subject || 'Account update';
    const safeSubject = escapeHtml(subject || heading);
    const safeHeading = escapeHtml(heading);
    const label = escapeHtml(explicitEventLabel || eventLabel(eventType));
    const body = paragraphHtml(text);
    const rows = normalizedFacts(payload, facts, nextStep);
    const factTable = factTableHtml(rows);
    const destination = String(actionUrl || payload.accountUrl || '').trim();
    const ctaText = actionLabel || (destination ? 'Open your account' : '');
    const cta = destination
        ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 6px;"><tr><td style="border-radius:10px;background:#1e3a5f;"><a href="${escapeHtml(destination)}" style="display:inline-block;padding:13px 22px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:.01em;">${escapeHtml(ctaText)}</a></td></tr></table>`
        : '';
    const home = String(publicBaseUrl || '').trim();
    const footerLink = home
        ? `<a href="${escapeHtml(home)}" style="color:#64748b;text-decoration:underline;">${escapeHtml(home)}</a>`
        : safeSiteName;
    const unsubscribe = !transactional && unsubscribeUrl
        ? `<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#64748b;text-decoration:underline;">Unsubscribe from marketing messages</a>`
        : '';
    const footerMessage = transactional
        ? `This is an automated service message from ${safeSiteName}. Please do not share account, payment or access links with anyone else.`
        : `This marketing message was sent by ${safeSiteName}.`;
    const hiddenPreheader = escapeHtml(preheader || subject || heading);
    const stripe = toneColour(tone);

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${safeSubject}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${hiddenPreheader}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f1f5f9;margin:0;padding:0;">
<tr><td align="center" style="padding:36px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;">
<tr><td style="padding:0 4px 18px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
<td style="font-size:21px;font-weight:800;letter-spacing:-.02em;color:#0f172a;">${safeSiteName}</td>
<td align="right"><span style="display:inline-block;padding:6px 10px;border-radius:999px;background:#e2e8f0;color:#475569;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;">${label}</span></td>
</tr></table>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:38px 40px;box-shadow:0 10px 30px rgba(15,23,42,.06);">
<div style="width:42px;height:4px;border-radius:999px;background:${stripe};margin-bottom:24px;"></div>
<h1 style="margin:0 0 18px;color:#0f172a;font-size:27px;line-height:1.25;letter-spacing:-.025em;font-weight:800;">${safeHeading}</h1>
${body}
${factTable}
${cta}
</td></tr>
<tr><td style="padding:22px 8px 0;color:#64748b;font-size:12px;line-height:1.6;text-align:center;">
${footerMessage}<br>
${footerLink}${unsubscribe}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = {
    escapeHtml,
    firstUrl,
    humanizeEventType,
    eventLabel,
    normalizedFacts,
    renderProfessionalEmail
};
