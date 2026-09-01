'use strict';

const moneyFormat=require('./money-format');

const { esc } = require('./admin-html');

function number(value, digits = 0) {
    return Number(value || 0).toLocaleString('en-GB', { maximumFractionDigits: digits });
}

function money(minor, currency = 'USD') {
    return moneyFormat.formatMinor(minor,currency,{trimZeroDecimals:true});
}
function hours(seconds) {
    const value = Number(seconds || 0) / 3600;
    if (value < 1 && value > 0) return `${Math.round(value * 60)}m`;
    return `${number(value, value < 10 ? 1 : 0)}h`;
}

function dateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function shortDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function deltaBadge(value) {
    if (value == null) return '<span class="delta flat">new</span>';
    const rounded = Math.round(Number(value));
    if (!rounded) return '<span class="delta flat">0%</span>';
    return `<span class="delta ${rounded > 0 ? 'up' : 'down'}">${rounded > 0 ? '↑' : '↓'} ${esc(Math.abs(rounded))}%</span>`;
}

module.exports = { number, money, hours, dateTime, shortDate, deltaBadge };
