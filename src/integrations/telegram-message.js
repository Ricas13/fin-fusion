'use strict';

function clean(value, max = 500) {
    return String(value ?? '').trim().slice(0, max);
}

function escapeHtml(value) {
    return String(value ?? '').slice(0, 5000)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatInline(value) {
    const input = clean(value, 5000);
    let output = '';
    let cursor = 0;
    const pattern = /\*\*(.+?)\*\*/g;
    let match;
    while ((match = pattern.exec(input))) {
        output += escapeHtml(input.slice(cursor, match.index));
        output += `<b>${escapeHtml(match[1])}</b>`;
        cursor = match.index + match[0].length;
    }
    return output + escapeHtml(input.slice(cursor));
}

function safeUrl(value) {
    const raw = clean(value, 1000);
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
        return parsed.toString();
    } catch (_) {
        return '';
    }
}

function normaliseFields(rows = []) {
    return (Array.isArray(rows) ? rows : [])
        .map(row => ({
            name: clean(row?.name ?? row?.label, 160),
            value: clean(row?.value, 700)
        }))
        .filter(row => row.name && row.value)
        .slice(0, 8);
}

function card({
    title = 'CAPTAiN FiN',
    description = '',
    fields = [],
    footer = 'CAPTAiN FiN',
    buttonLabel = '',
    buttonUrl = ''
} = {}) {
    const sections = [`<b>${escapeHtml(clean(title, 220) || 'CAPTAiN FiN')}</b>`];
    const body = clean(description, 1800);
    if (body) sections.push(formatInline(body));
    const safeFields = normaliseFields(fields);
    if (safeFields.length) {
        sections.push(safeFields.map(row => `<b>${escapeHtml(row.name)}</b>\n${formatInline(row.value)}`).join('\n\n'));
    }
    const footerText = clean(footer, 260);
    if (footerText) sections.push(`<i>${escapeHtml(footerText)}</i>`);
    const href = safeUrl(buttonUrl);
    const label = clean(buttonLabel, 64);
    return {
        text: sections.join('\n\n').slice(0, 3900),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(href && label ? { reply_markup: { inline_keyboard: [[{ text: label, url: href }]] } } : {})
    };
}

function body(message = null, { chatId = '', fallbackText = '' } = {}) {
    const source = message && typeof message === 'object' && !Array.isArray(message) ? message : {};
    const text = clean(source.text, 3900) || escapeHtml(clean(fallbackText, 3900)) || 'CAPTAiN FiN notification';
    const parseMode = source.parse_mode === 'HTML' ? 'HTML' : undefined;
    const button = Array.isArray(source.reply_markup?.inline_keyboard)
        ? source.reply_markup.inline_keyboard.flat().find(item => safeUrl(item?.url) && clean(item?.text, 64))
        : null;
    return {
        chat_id: clean(chatId, 120),
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        disable_web_page_preview: true,
        ...(button ? { reply_markup: { inline_keyboard: [[{ text: clean(button.text, 64), url: safeUrl(button.url) }]] } } : {})
    };
}

async function send(settings, { chatId = '', message = null, fallbackText = '' } = {}) {
    const cfg = await settings.get();
    if (!cfg.telegramEnabled || !cfg.telegramToken) throw new Error('Telegram bot is not configured.');
    const destination = clean(chatId || cfg.telegramAdminChatId, 120);
    if (!destination) throw new Error('Telegram destination chat is not linked.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body(message, { chatId: destination, fallbackText })),
            redirect: 'error',
            signal: controller.signal
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
        }
        return response.json().catch(() => ({}));
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { clean, escapeHtml, formatInline, safeUrl, normaliseFields, card, body, send };
