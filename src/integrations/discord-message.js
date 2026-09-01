'use strict';

const COLORS = Object.freeze({
    info: 0x5865F2,
    success: 0x57F287,
    warn: 0xF0B232,
    bad: 0xED4245,
    neutral: 0x99AAB5
});

function clean(value, max = 500) {
    return String(value ?? '').trim().slice(0, max);
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

function toneColor(tone) {
    return COLORS[tone] || COLORS.info;
}

function normaliseFields(rows = []) {
    return (Array.isArray(rows) ? rows : [])
        .map(row => ({
            name: clean(row?.name ?? row?.label, 220),
            value: clean(row?.value, 900),
            inline: Boolean(row?.inline)
        }))
        .filter(row => row.name && row.value)
        .slice(0, 8);
}

function linkButton(label, url) {
    const href = safeUrl(url);
    const text = clean(label, 80);
    if (!href || !text) return null;
    return {
        type: 1,
        components: [{ type: 2, style: 5, label: text, url: href }]
    };
}

function card({
    content = '',
    title = 'CAPTAiN FiN',
    description = '',
    tone = 'info',
    fields = [],
    url = '',
    footer = 'CAPTAiN FiN',
    buttonLabel = '',
    buttonUrl = ''
} = {}) {
    const embed = {
        title: clean(title, 240) || 'CAPTAiN FiN',
        color: toneColor(tone)
    };
    const body = clean(description, 2400);
    if (body) embed.description = body;
    const href = safeUrl(url);
    if (href) embed.url = href;
    const safeFields = normaliseFields(fields);
    if (safeFields.length) embed.fields = safeFields;
    const footerText = clean(footer, 300);
    if (footerText) embed.footer = { text: footerText };
    const button = linkButton(buttonLabel, buttonUrl);
    return {
        content: clean(content, 1900),
        embeds: [embed],
        ...(button ? { components: [button] } : {})
    };
}

function normaliseEmbed(embed = {}) {
    const output = {};
    const title = clean(embed.title, 240);
    const description = clean(embed.description, 2400);
    const url = safeUrl(embed.url);
    const color = Number(embed.color);
    const fields = normaliseFields(embed.fields);
    const footerText = clean(embed.footer?.text, 300);
    if (title) output.title = title;
    if (description) output.description = description;
    if (url) output.url = url;
    if (Number.isInteger(color) && color >= 0 && color <= 0xFFFFFF) output.color = color;
    if (fields.length) output.fields = fields;
    if (footerText) output.footer = { text: footerText };
    return output;
}

function normaliseComponents(components = []) {
    const rows = [];
    for (const row of Array.isArray(components) ? components : []) {
        const button = Array.isArray(row?.components)
            ? row.components.find(component => Number(component?.type) === 2 && Number(component?.style) === 5)
            : null;
        const href = safeUrl(button?.url);
        const label = clean(button?.label, 80);
        if (!href || !label) continue;
        rows.push({ type: 1, components: [{ type: 2, style: 5, label, url: href }] });
        if (rows.length >= 1) break;
    }
    return rows;
}

function body(message = null, { fallbackText = '', allowEveryone = false } = {}) {
    const source = message && typeof message === 'object' ? message : {};
    const embeds = (Array.isArray(source.embeds) ? source.embeds : [])
        .map(normaliseEmbed)
        .filter(embed => Object.keys(embed).length)
        .slice(0, 1);
    const components = normaliseComponents(source.components);
    let content = clean(source.content, allowEveryone ? 1888 : 1900);
    if (!content && !embeds.length) content = clean(fallbackText, allowEveryone ? 1888 : 1900);
    if (allowEveryone) content = `@everyone${content ? ` ${content}` : ''}`.slice(0, 1900);
    if (!content && !embeds.length) content = 'CAPTAiN FiN notification';
    return {
        content,
        ...(embeds.length ? { embeds } : {}),
        ...(components.length ? { components } : {}),
        allowed_mentions: { parse: allowEveryone ? ['everyone'] : [] }
    };
}

module.exports = { COLORS, clean, safeUrl, toneColor, card, body, normaliseFields };
