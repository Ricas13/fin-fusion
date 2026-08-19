'use strict';

const { esc } = require('./admin-html');
const { number, deltaBadge } = require('./admin-dashboard-format');

const SPAN_VALUES = [3, 4, 6, 8, 9, 12];
const TONE_VARS = ['--accent', '--green', '--amber', '--red', '--chart-tertiary-1', '--chart-tertiary-2'];

function toneVar(index) {
    return `var(${TONE_VARS[index % TONE_VARS.length]})`;
}

// --- Non-data states -------------------------------------------------------

function emptyState(message) {
    return `<div class="analyticsEmpty">${esc(message)}</div>`;
}

function errorState(message) {
    return `<div class="analyticsEmpty widgetError">${esc(message)}</div>`;
}

function loadingSkeleton() {
    return '<div class="widgetSkeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
}

// --- Sparkline / KPI ---------------------------------------------------------

function sparkline(points, { width = 120, height = 32, valueKey = 'value' } = {}) {
    const values = (points || []).map(row => Number(row?.[valueKey] ?? row ?? 0));
    if (!values.length || !values.some(v => v > 0)) return '';
    const max = Math.max(1, ...values);
    const min = Math.min(0, ...values);
    const span = Math.max(1, max - min);
    const step = values.length <= 1 ? width : width / (values.length - 1);
    const coords = values.map((v, i) => {
        const x = values.length <= 1 ? width / 2 : i * step;
        const y = height - ((v - min) / span * height);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg class="widgetSparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Trend"><polyline points="${coords}"/></svg>`;
}

function kpiCard({ key, label, value, meta, delta, sparklineData, tone = '', href } = {}) {
    const spark = sparklineData ? sparkline(sparklineData) : '';
    const inner = `<div class="analyticsKpiLabel">${esc(label)}</div><div class="analyticsKpiValue">${value}</div><div class="analyticsKpiMeta">${delta !== undefined ? deltaBadge(delta) : ''}<span>${esc(meta || '')}</span></div>${spark ? `<div class="analyticsKpiSpark">${spark}</div>` : ''}`;
    const cls = `analyticsKpi ${tone ? `tone-${esc(tone)}` : ''}`;
    return href
        ? `<a class="${cls}" href="${esc(href)}" data-kpi-key="${esc(key || '')}">${inner}</a>`
        : `<div class="${cls}" data-kpi-key="${esc(key || '')}">${inner}</div>`;
}

// --- Existing chart primitives (bar / area), extended -----------------------

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

function barChart(rows, valueKey, formatter = value => number(value), { orientation = 'vertical' } = {}) {
    if (!rows.length || !rows.some(row => Number(row[valueKey] || 0) > 0)) return emptyState('No data in this period.');
    if (orientation === 'horizontal') return horizontalBarChart(rows, valueKey, formatter);
    const width = 720, height = 250, left = 48, right = 18, top = 18, bottom = 38;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const max = Math.max(1, ...rows.map(row => Number(row[valueKey] || 0)));
    const band = plotWidth / Math.max(1, rows.length);
    const barWidth = Math.max(2, Math.min(28, band * .62));
    let grid = '';
    for (let i = 0; i <= 4; i++) {
        const ratio = i / 4;
        const y = top + plotHeight - plotHeight * ratio;
        const value = max * ratio;
        grid += `<line class="chartGridLine" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chartAxisText" x="${left - 7}" y="${y + 3}" text-anchor="end">${esc(formatter(value))}</text>`;
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

function horizontalBarChart(rows, valueKey, formatter = value => number(value)) {
    if (!rows.length || !rows.some(row => Number(row[valueKey] || 0) > 0)) return emptyState('No data in this period.');
    const max = Math.max(1, ...rows.map(row => Number(row[valueKey] || 0)));
    return `<div class="barList">${rows.map(row => {
        const value = Number(row[valueKey] || 0);
        return `<div class="barItem"><div class="barItemLabel"><strong title="${esc(row.label)}">${esc(row.label)}</strong></div><div class="barTrack"><div class="barFill" style="width:${Math.max(2, value / max * 100).toFixed(1)}%"></div></div><div class="barValue">${esc(formatter(value))}</div></div>`;
    }).join('')}</div>`;
}

function areaChart(rows, valueKey, formatter = value => number(value)) {
    if (!rows.length || !rows.some(row => Number(row[valueKey] || 0) > 0)) return emptyState('No data in this period.');
    const width = 720, height = 250, left = 48, right = 18, top = 18, bottom = 38;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const values = rows.map(row => Number(row[valueKey] || 0));
    const max = Math.max(1, ...values);
    const min = Math.min(0, ...values);
    const span = Math.max(1, max - min);
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

// --- New chart primitives ----------------------------------------------------

function stackedAreaChart(rows, seriesKeys, formatter = value => number(value)) {
    if (!rows.length || !seriesKeys.length) return emptyState('No data in this period.');
    const total = row => seriesKeys.reduce((sum, key) => sum + Number(row[key] || 0), 0);
    if (!rows.some(row => total(row) > 0)) return emptyState('No data in this period.');
    const width = 720, height = 250, left = 48, right = 18, top = 18, bottom = 38;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const max = Math.max(1, ...rows.map(total));
    const step = rows.length <= 1 ? plotWidth : plotWidth / (rows.length - 1);
    const x = index => left + (rows.length <= 1 ? plotWidth / 2 : index * step);
    const y = value => top + plotHeight - (value / max * plotHeight);
    let grid = '';
    for (let i = 0; i <= 4; i++) {
        const ratio = i / 4;
        const gy = top + plotHeight - plotHeight * ratio;
        grid += `<line class="chartGridLine" x1="${left}" x2="${width - right}" y1="${gy}" y2="${gy}"/><text class="chartAxisText" x="${left - 7}" y="${gy + 3}" text-anchor="end">${esc(formatter(max * ratio))}</text>`;
    }
    const baseline = top + plotHeight;
    let cumulative = rows.map(() => 0);
    const layers = seriesKeys.map((key, seriesIndex) => {
        const nextCumulative = rows.map((row, i) => cumulative[i] + Number(row[key] || 0));
        const topPoints = nextCumulative.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        const bottomPoints = [...cumulative].reverse().map((v, revIndex) => {
            const i = rows.length - 1 - revIndex;
            return `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        }).join(' ');
        const polygon = `${topPoints} ${bottomPoints}`;
        cumulative = nextCumulative;
        return `<polygon class="chartAreaSeries" style="fill:${toneVar(seriesIndex)};opacity:.55" points="${polygon}"/>`;
    }).join('');
    return `<div class="chartFrame"><svg class="chartSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Stacked trend chart">${grid}<line x1="${left}" x2="${width - right}" y1="${baseline}" y2="${baseline}" class="chartGridLine"/>${layers}${chartLabels(rows, width, left, right)}</svg></div>`;
}

function donutChart(rows, { labelKey = 'name', valueKey = 'count', formatter = value => number(value), size = 180 } = {}) {
    if (!rows.length) return emptyState('No data in this period.');
    const total = rows.reduce((sum, row) => sum + Number(row[valueKey] || 0), 0);
    if (!total) return emptyState('No data in this period.');
    const radius = size / 2, stroke = size * 0.22, r = radius - stroke / 2;
    const circumference = 2 * Math.PI * r;
    let offset = 0;
    const slices = rows.map((row, index) => {
        const value = Number(row[valueKey] || 0);
        const fraction = value / total;
        const dash = fraction * circumference;
        const slice = `<circle class="chartDonutSlice" cx="${radius}" cy="${radius}" r="${r}" stroke="${toneVar(index)}" stroke-width="${stroke}" stroke-dasharray="${dash.toFixed(1)} ${(circumference - dash).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}"><title>${esc(row[labelKey])}: ${esc(formatter(value))}</title></circle>`;
        offset += dash;
        return slice;
    }).join('');
    const legend = rows.map((row, index) => `<span class="chartLegendItem"><i style="background:${toneVar(index)}"></i>${esc(row[labelKey])} · ${esc(formatter(Number(row[valueKey] || 0)))}</span>`).join('');
    return `<div class="chartDonutWrap"><svg class="chartDonut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Breakdown"><g transform="rotate(-90 ${radius} ${radius})">${slices}</g><text class="chartDonutTotal" x="${radius}" y="${radius}" text-anchor="middle" dominant-baseline="middle">${esc(formatter(total))}</text></svg><div class="chartLegend">${legend}</div></div>`;
}

function funnelChart(stages) {
    if (!stages || !stages.length) return emptyState('No funnel data available.');
    const max = Math.max(1, ...stages.map(stage => Number(stage.count || 0)));
    return `<div class="chartFunnel">${stages.map((stage, index) => {
        const value = Number(stage.count || 0);
        const width = Math.max(6, value / max * 100).toFixed(1);
        const previous = index > 0 ? Number(stages[index - 1].count || 0) : null;
        const dropoff = previous ? Math.round((1 - value / Math.max(1, previous)) * 100) : null;
        const inner = `<div class="chartFunnelLabel"><strong>${esc(stage.label)}</strong><span>${esc(number(value))}${dropoff != null ? ` <em>· −${esc(dropoff)}%</em>` : ''}</span></div><div class="chartFunnelTrack"><div class="chartFunnelFill" style="width:${width}%"></div></div>`;
        return stage.href ? `<a class="chartFunnelStage" href="${esc(stage.href)}">${inner}</a>` : `<div class="chartFunnelStage">${inner}</div>`;
    }).join('')}</div>`;
}

function heatmap(matrix, { rowLabels = [], colLabels = [], formatter = value => number(value) } = {}) {
    if (!matrix || !matrix.length) return emptyState('No data available.');
    const max = Math.max(1, ...matrix.flat().map(v => Number(v || 0)));
    const head = `<tr><th></th>${colLabels.map(label => `<th>${esc(label)}</th>`).join('')}</tr>`;
    const body = matrix.map((row, rowIndex) => `<tr><th>${esc(rowLabels[rowIndex] || '')}</th>${row.map(value => {
        const ratio = Math.max(0, Math.min(1, Number(value || 0) / max));
        const pct = Math.round(ratio * 100);
        return `<td style="background:color-mix(in srgb, var(--accent) ${pct}%, transparent)"><span>${esc(formatter(value))}</span></td>`;
    }).join('')}</tr>`).join('');
    return `<div class="chartFrame"><table class="chartHeatmap">${head}${body}</table></div>`;
}

function healthWidget(items) {
    if (!items || !items.length) return emptyState('No health signals available.');
    return `<div class="widgetHealthList">${items.map(item => {
        const cls = ['good', 'warn', 'bad'].includes(item.status) ? item.status : '';
        const inner = `<span class="pill ${cls}">${esc(item.status === 'unknown' ? 'unknown' : item.status)}</span><strong>${esc(item.label)}</strong>${item.detail ? `<span class="widgetHealthDetail">${esc(item.detail)}</span>` : ''}`;
        return item.href ? `<a class="widgetHealthRow" href="${esc(item.href)}">${inner}</a>` : `<div class="widgetHealthRow">${inner}</div>`;
    }).join('')}</div>`;
}

function statusTable(rows, columns) {
    if (!rows || !rows.length) return emptyState('No rows to show.');
    const head = `<tr>${columns.map(col => `<th${col.align === 'numeric' ? ' class="numeric"' : ''}>${esc(col.label)}</th>`).join('')}</tr>`;
    const body = rows.map(row => `<tr>${columns.map(col => {
        const value = col.render ? col.render(row) : esc(row[col.key]);
        return `<td${col.align === 'numeric' ? ' class="numeric"' : ''}>${value}</td>`;
    }).join('')}</tr>`).join('');
    return `<table class="analyticsTable">${head}${body}</table>`;
}

// --- Widget shell / layout chrome --------------------------------------------

function widgetShell(spec, bodyHtml, { span = 6, stat = null, dataUnavailable = false, hidden = false } = {}) {
    const safeSpan = SPAN_VALUES.includes(Number(span)) ? Number(span) : 6;
    const statHtml = stat ? `<div class="analyticsCardHeaderStat"><strong>${stat.value}</strong><span>${esc(stat.label || '')}</span></div>` : '';
    const tooltip = spec.subtitle ? ` popover="manual" title="${esc(spec.subtitle)}"` : '';
    return `<section class="analyticsCard widgetCard span-${safeSpan} ${dataUnavailable ? 'widgetUnavailable' : ''} ${hidden ? 'widgetHidden' : ''}" data-widget-key="${esc(spec.key || '')}" data-widget-span="${safeSpan}">
        <div class="analyticsCardHeader">
            <div><h2>${esc(spec.title)}<button type="button" class="widgetInfo" aria-label="About ${esc(spec.title)}"${tooltip}>ⓘ</button></h2>${spec.subtitle ? `<p>${esc(spec.subtitle)}</p>` : ''}</div>
            ${statHtml}
            <div class="widgetChrome" aria-hidden="true">
                <button type="button" class="widgetDragHandle" data-widget-drag aria-label="Drag to reorder">⋮⋮</button>
                <button type="button" class="widgetSpanMenu" data-widget-span-toggle aria-label="Resize widget">⤢</button>
                <button type="button" class="widgetHideButton" data-widget-hide aria-label="Hide widget">✕</button>
            </div>
        </div>
        <div class="analyticsCardBody">${bodyHtml}</div>
    </section>`;
}

function timeframeControl(widgetKey, allowedRanges, current) {
    if (!allowedRanges || !allowedRanges.length) return '';
    const labels = { today: 'Today', '7d': '7d', '30d': '30d', '90d': '90d', '365d': '12mo' };
    return `<div class="widgetTimeframe" data-widget-timeframe="${esc(widgetKey)}">${allowedRanges.map(key => `<a class="widgetTimeframePill ${key === current ? 'active' : ''}" href="?w_${esc(widgetKey)}=${esc(key)}">${esc(labels[key] || key)}</a>`).join('')}</div>`;
}

module.exports = {
    SPAN_VALUES,
    sparkline,
    kpiCard,
    barChart,
    areaChart,
    stackedAreaChart,
    donutChart,
    funnelChart,
    heatmap,
    healthWidget,
    statusTable,
    emptyState,
    errorState,
    loadingSkeleton,
    widgetShell,
    timeframeControl
};
