'use strict';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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

function eventLabel(eventType) {
    const labels = {
        'customer.subscription.requested': 'Subscription update',
        'customer.trial.requested': 'Trial update',
        'customer.stremio.requested': 'Stremio update',
        'customer.service.provisioned': 'Service ready',
        'payment.failed': 'Payment attention required',
        'payment.received': 'Payment confirmation',
        'subscription.activated': 'Subscription active',
        'subscription.expiring': 'Subscription reminder',
        'subscription.cancelled': 'Subscription update'
    };
    return labels[eventType] || 'Account notification';
}

function renderProfessionalEmail({ subject, text, eventType = '', siteName = 'CAPTAiNFiN', publicBaseUrl = '' }) {
    const safeSiteName = escapeHtml(siteName || 'CAPTAiNFiN');
    const safeSubject = escapeHtml(subject || 'Account update');
    const label = escapeHtml(eventLabel(eventType));
    const url = firstUrl(text);
    const body = paragraphHtml(text);
    const home = String(publicBaseUrl || '').trim();
    const destination = url || home;
    const cta = destination
        ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 6px;"><tr><td style="border-radius:10px;background:#2563eb;"><a href="${escapeHtml(destination)}" style="display:inline-block;padding:13px 22px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:.01em;">Open ${safeSiteName}</a></td></tr></table>`
        : '';
    const footerLink = home
        ? `<a href="${escapeHtml(home)}" style="color:#64748b;text-decoration:underline;">${escapeHtml(home)}</a>`
        : safeSiteName;

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${safeSubject}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safeSubject}</div>
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
<div style="width:42px;height:4px;border-radius:999px;background:#2563eb;margin-bottom:24px;"></div>
<h1 style="margin:0 0 18px;color:#0f172a;font-size:27px;line-height:1.25;letter-spacing:-.025em;font-weight:800;">${safeSubject}</h1>
${body}
${cta}
</td></tr>
<tr><td style="padding:22px 8px 0;color:#64748b;font-size:12px;line-height:1.6;text-align:center;">
This is an automated service message from ${safeSiteName}. Please do not share account, payment or access links with anyone else.<br>
${footerLink}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = { escapeHtml, firstUrl, eventLabel, renderProfessionalEmail };
