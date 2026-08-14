'use strict';

function csvField(value) {
    if (value === null || value === undefined) return '';
    let text;
    if (value instanceof Date) text = value.toISOString();
    else if (typeof value === 'object') text = JSON.stringify(value);
    else text = String(value);
    if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
}

function toCsv(columns, rows) {
    const header = columns.map(c => csvField(c.label)).join(',');
    const body = rows.map(row => columns.map(c => csvField(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(',')).join('\r\n');
    return `${header}\r\n${body}${rows.length ? '\r\n' : ''}`;
}

function sendCsv(res, filename, columns, rows) {
    const safeName = String(filename || 'export').replace(/[^a-zA-Z0-9_.-]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    return res.send('﻿' + toCsv(columns, rows));
}

module.exports = { toCsv, sendCsv };
