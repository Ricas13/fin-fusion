'use strict';

const { esc } = require('./admin-html');

function number(value, digits = 0) {
    return Number(value || 0).toLocaleString('en-GB', { maximumFractionDigits: digits });
}

function money(minor, currency = 'USD') {
    try {
        return new Intl.NumberFormat('en-GB', {
            style: 'currency',
            currency: String(currency || 'USD').toUpperCase(),
            currencyDisplay: 'narrowSymbol',
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }).format(Number(minor || 0) / 100);
    } catch (_) {
        return `${esc(currency || 'USD')} ${(Number(minor || 0) / 100).toFixed(2)}`;
    }
}

function hours(seconds) {
    const value = Number(seconds || 0) / 3600;
    if (value < 1 && value > 0) return `${Math.round(value * 60)}m`;
    return `${number(value, value < 10 ? 1 : 0)}h`;
}

function rangeControls(range, basePath = '/admin') {
    const presets = [
        ['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'],
        ['90d', '90 days'], ['180d', '6 months'], ['365d', '12 months']
    ];
    return `<section class="dashboardRangeBar">
        <div class="rangeMeta"><strong>${esc(range.label)}</strong><span>Every historical KPI and chart below uses this same period. Live cards are marked separately.</span></div>
        <div class="rangeControls">
            <div class="rangePresets">${presets.map(([key, label]) => `<a class="rangePreset ${range.key === key ? 'active' : ''}" href="${esc(basePath)}?range=${esc(key)}">${esc(label)}</a>`).join('')}</div>
            <form class="rangeCustom" method="get" action="${esc(basePath)}">
                <input type="hidden" name="range" value="custom">
                <label>From<input type="date" name="from" value="${esc(range.from)}" required></label>
                <label>To<input type="date" name="to" value="${esc(range.to)}" required></label>
                <button class="button secondary" type="submit">Apply</button>
            </form>
        </div>
    </section>`;
}

function chartLabels(rows, width, left, right) {
    if (!rows.length) return '';
    const plotWidth = width - left - right;
    const step = rows.length <= 1 ? plotWidth : plotWidth / (rows.length - 1);
    const every = Math.max(1, Math.ceil(rows.length / 6));
    return rows.map((row, index) => {
        if (index !== 0 && index !== rows.length - 1 && index % every !== 0) return '';
        const x = left + (rows.length <= 1 ? plotWidth / 2 : index * step);
        return `<text class="chartAxisText" x="${x.toFixed(1)}" y="238" text-anchor="middle">${esc(row.label)}</text>`;
    }).join('');
}

function barChart(rows, valueKey, formatter = value => number(value)) {
    if (!rows.length || !rows.some(row => Number(row[valueKey] || 0) > 0)) return '<div class="chartEmpty">No data in this period.</div>';
    const width = 720, height = 250, left = 48, right = 18, top = 18, bottom = 38;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const max = Math.max(1, ...rows.map(row => Number(row[valueKey] || 0)));
    const band = plotWidth / Math.max(1, rows.length);
    const barWidth = Math.max(2, Math.min(28, band * .62));
    let grid = '';
    for (let i = 0; i <= 4; i++) {
        const ratio = i / 4;
        const y = top + plotHeight - plotHeight * ratio;
        grid += `<line class="chartGridLine" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chartAxisText" x="${left - 7}" y="${y + 3}" text-anchor="end">${esc(formatter(max * ratio))}</text>`;
    }
    const bars = rows.map((row, index) => {
        const value = Number(row[valueKey] || 0);
        const h = value / max * plotHeight;
        const x = left + index * band + (band - barWidth) / 2;
        const y = top + plotHeight - h;
        return `<rect class="chartBar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3"><title>${esc(row.label)}: ${esc(formatter(value))}</title></rect>`;
    }).join('');
    return `<div class="chartFrame"><svg class="chartSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend chart">${grid}${bars}${chartLabels(rows, width, left, right)}</svg></div>`;
}

function areaChart(rows, valueKey, formatter = value => number(value)) {
    if (!rows.length || !rows.some(row => Number(row[valueKey] || 0) > 0)) return '<div class="chartEmpty">No data in this period.</div>';
    const width = 720, height = 250, left = 48, right = 18, top = 18, bottom = 38;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const values = rows.map(row => Number(row[valueKey] || 0));
    const max = Math.max(1, ...values), min = Math.min(0, ...values), span = Math.max(1, max - min);
    const step = rows.length <= 1 ? plotWidth : plotWidth / (rows.length - 1);
    const point = (value, index) => {
        const x = left + (rows.length <= 1 ? plotWidth / 2 : index * step);
        const y = top + plotHeight - ((value - min) / span * plotHeight);
        return [x, y];
    };
    const points = values.map(point);
    let grid = '';
    for (let i = 0; i <= 4; i++) {
        const ratio = i / 4;
        const y = top + plotHeight - plotHeight * ratio;
        const value = min + span * ratio;
        grid += `<line class="chartGridLine" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chartAxisText" x="${left - 7}" y="${y + 3}" text-anchor="end">${esc(formatter(value))}</text>`;
    }
    const baseline = top + plotHeight;
    const polyline = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${left},${baseline} ${polyline} ${width - right},${baseline}`;
    const dots = points.length <= 45 ? points.map(([x, y], index) => `<circle class="chartPoint" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8"><title>${esc(rows[index].label)}: ${esc(formatter(values[index]))}</title></circle>`).join('') : '';
    return `<div class="chartFrame"><svg class="chartSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend chart">${grid}<polygon class="chartArea" points="${area}"/><polyline class="chartLine" points="${polyline}"/>${dots}${chartLabels(rows, width, left, right)}</svg></div>`;
}

module.exports = { money, hours, barChart, areaChart, rangeControls };
