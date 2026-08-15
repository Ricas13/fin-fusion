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

function kpi(label, value, meta, delta = undefined) {
    return `<div class="analyticsKpi"><div class="analyticsKpiLabel">${esc(label)}</div><div class="analyticsKpiValue">${value}</div><div class="analyticsKpiMeta">${delta !== undefined ? deltaBadge(delta) : ''}<span>${esc(meta)}</span></div></div>`;
}

function rangeControls(range) {
    const presets = [
        ['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['180d', '6 months'], ['365d', '12 months']
    ];
    return `<section class="dashboardRangeBar">
        <div class="rangeMeta"><strong>${esc(range.label)}</strong><span>Every historical KPI and chart below uses this same period. Live cards are marked separately.</span></div>
        <div class="rangeControls">
            <div class="rangePresets">${presets.map(([key, label]) => `<a class="rangePreset ${range.key === key ? 'active' : ''}" href="/admin?range=${esc(key)}">${esc(label)}</a>`).join('')}</div>
            <form class="rangeCustom" method="get" action="/admin">
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

function areaChart(rows, valueKey, formatter = value => number(value)) {
    if (!rows.length || !rows.some(row => Number(row[valueKey] || 0) > 0)) return '<div class="chartEmpty">No data in this period.</div>';
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

function barList(rows, { label = 'name', value = 'count', valueText = row => number(row[value]), meta = () => '' } = {}) {
    if (!rows.length) return '<div class="analyticsEmpty">No data in this period.</div>';
    const max = Math.max(1, ...rows.map(row => Number(row[value] || 0)));
    return `<div class="barList">${rows.map(row => `<div class="barItem"><div class="barItemLabel"><strong title="${esc(row[label])}">${esc(row[label])}</strong>${meta(row) ? `<span>${esc(meta(row))}</span>` : ''}</div><div class="barTrack"><div class="barFill" style="width:${Math.max(2, Number(row[value] || 0) / max * 100).toFixed(1)}%"></div></div><div class="barValue">${valueText(row)}</div></div>`).join('')}</div>`;
}

function analyticsCard(title, subtitle, body, options = {}) {
    const cls = options.className || '';
    const stat = options.stat ? `<div class="analyticsCardHeaderStat"><strong>${options.stat.value}</strong><span>${esc(options.stat.label || '')}</span></div>` : '';
    return `<section class="analyticsCard ${cls}"><div class="analyticsCardHeader"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>${stat}</div><div class="analyticsCardBody">${body}</div></section>`;
}

function setupCompact(s) {
    const setup = s.setup;
    if (!setup || setup.configuredCount >= setup.totalCount) return '';
    return `<div class="setupCompact"><div><strong>Platform setup is not complete</strong><br><span>${esc(setup.configuredCount)} of ${esc(setup.totalCount)} optional setup areas currently configured.</span></div><a class="button secondary" href="/admin/setup">Open Setup</a></div>`;
}

function operationalAlerts(s) {
    const o = s.operational || {};
    const items = [
        [`${number(o.offline_servers)} offline server${Number(o.offline_servers) === 1 ? '' : 's'}`, Number(o.offline_servers) ? 'bad' : '', '/admin/servers'],
        [`${number(o.provisioning_problems)} provisioning problem${Number(o.provisioning_problems) === 1 ? '' : 's'}`, Number(o.provisioning_problems) ? 'warn' : '', '/admin/provisioning'],
        [`${number(o.payment_errors_24h)} payment error${Number(o.payment_errors_24h) === 1 ? '' : 's'} · 24h`, Number(o.payment_errors_24h) ? 'warn' : '', '/admin/payments'],
        [`${number(o.pending_requests)} pending request${Number(o.pending_requests) === 1 ? '' : 's'}`, '', '/admin/request-users']
    ];
    return `<div class="dashboardAlertRow">${items.map(([text, kind, href]) => `<a class="dashboardAlert ${kind}" href="${href}" style="text-decoration:none"><strong>${esc(text.split(' ')[0])}</strong>${esc(text.slice(text.indexOf(' ') + 1))}</a>`).join('')}</div>`;
}

function revenueCard(s) {
    const currency = s.revenue.primaryCurrency;
    const body = `${barChart(s.revenue.series, 'revenue_minor', value => money(value, currency))}${s.revenue.currencies.length > 1 ? `<div class="currencyBreakdown">${s.revenue.currencies.map(row => `<span class="currencyPill">${esc(row.currency)} ${esc(money(row.minor, row.currency))}</span>`).join('')}</div>` : ''}<div class="analyticsFootnote">Webhook-confirmed gross Stripe/PayPal payments only. Manual subscriptions, reseller credits and provider fees are not counted as revenue.</div>`;
    return analyticsCard('Revenue history', `Successful provider payments · ${s.range.label}`, body, { className: 'wide', stat: { value: money(s.revenue.totalMinor, currency), label: 'gross revenue' } });
}

function customerGrowthCard(s) {
    return analyticsCard('Customer base over time', 'Cumulative CAPTaINFiN customer accounts', areaChart(s.customerGrowth, 'total'), { className: 'narrow', stat: { value: number(s.current.customers), label: 'customers now' } });
}

function playbackCard(s) {
    const transcodeRate = s.period.playbackSessions ? (s.period.transcodeSessions / s.period.playbackSessions * 100) : 0;
    const body = `<div class="miniStats"><div class="miniStat"><strong>${hours(s.period.playbackSeconds)}</strong><span>watch time</span></div><div class="miniStat"><strong>${number(s.period.uniqueViewers)}</strong><span>unique viewers</span></div><div class="miniStat"><strong>${number(transcodeRate, 1)}%</strong><span>transcoded sessions</span></div></div>${barChart(s.playbackSeries, 'sessions')}`;
    return analyticsCard('Managed streaming volume', 'Playback history for customers managed by CAPTaINFiN', body, { className: 'wide', stat: { value: number(s.period.playbackSessions), label: 'sessions' } });
}

function planMixCard(s) {
    return analyticsCard('Product usage', 'Current active and trialing subscriptions by plan', barList(s.planMix, { value: 'count' }), { className: 'narrow', stat: { value: number(s.current.activeSubscriptions), label: 'active subscriptions' } });
}

function serverLoadCard(s) {
    if (!s.serverLoad.length) return analyticsCard('Server load', 'Live Jellyfin fleet snapshot', '<div class="analyticsEmpty">No enabled Jellyfin servers.</div>', { className: 'wide' });
    const maxStreams = Math.max(1, ...s.serverLoad.map(row => Number(row.active_streams || 0)));
    const body = `<div class="serverLoadGrid">${s.serverLoad.map(row => {
        const streams = Number(row.active_streams || 0), managed = Number(row.managed_streams || 0), users = Number(row.total_users || 0);
        return `<div class="serverLoadItem"><div class="serverLoadName"><strong>${esc(row.name)}</strong><span>${esc(row.server_class)} · ${esc(row.health_status || 'unknown')}</span></div><div class="barTrack"><div class="barFill" style="width:${Math.max(streams ? 3 : 0, streams / maxStreams * 100).toFixed(1)}%"></div></div><div class="serverLoadStats"><strong>${number(streams)} streams</strong>${number(managed)} managed · ${number(users)} users</div></div>`;
    }).join('')}</div><div class="analyticsFootnote">Live fleet stream/user figures include unmanaged legacy Jellyfin users. CAPTaINFiN enforcement still applies only to managed customers.</div>`;
    return analyticsCard('Server load', 'Live Jellyfin fleet snapshot', body, { className: 'wide', stat: { value: number(s.current.fleetStreams), label: `${number(s.current.managedStreams)} managed live` } });
}

function playbackMethodCard(s) {
    const labels = { directplay: 'Direct play', directstream: 'Direct stream', transcode: 'Transcode', unknown: 'Unknown' };
    const rows = s.playbackMethods.map(row => ({ ...row, name: labels[row.playback_method] || row.playback_method }));
    return analyticsCard('Playback methods', `Managed sessions · ${s.range.label}`, barList(rows, { value: 'count' }), { className: 'narrow' });
}

function streamerTable(s) {
    if (!s.topStreamers.length) return '<div class="analyticsEmpty">No managed playback in this period.</div>';
    return `<table class="analyticsTable"><thead><tr><th>Customer</th><th class="numeric">Sessions</th><th class="numeric">Watch time</th></tr></thead><tbody>${s.topStreamers.map(row => `<tr><td>${row.customer_id ? `<a href="/admin/users/${esc(row.customer_id)}"><strong>${esc(row.name)}</strong></a>` : `<strong>${esc(row.name)}</strong>`}</td><td class="numeric">${number(row.sessions)}</td><td class="numeric">${hours(row.seconds)}</td></tr>`).join('')}</tbody></table>`;
}

function deviceTable(s) {
    if (!s.topDevices.length) return '<div class="analyticsEmpty">No device activity in this period.</div>';
    return `<table class="analyticsTable"><thead><tr><th>Device</th><th class="numeric">Sessions</th><th class="numeric">Watch time</th></tr></thead><tbody>${s.topDevices.map(row => `<tr><td><strong>${esc(row.name)}</strong></td><td class="numeric">${number(row.sessions)}</td><td class="numeric">${hours(row.seconds)}</td></tr>`).join('')}</tbody></table>`;
}

function contentTable(s) {
    if (!s.topContent.length) return '<div class="analyticsEmpty">No playback history in this period.</div>';
    return `<table class="analyticsTable"><thead><tr><th>Title</th><th class="numeric">Sessions</th><th class="numeric">Watch time</th></tr></thead><tbody>${s.topContent.map(row => `<tr><td><strong>${esc(row.name)}</strong><span class="sub">${esc(row.item_type)}</span></td><td class="numeric">${number(row.sessions)}</td><td class="numeric">${hours(row.seconds)}</td></tr>`).join('')}</tbody></table>`;
}

function renewalsCard(s) {
    const totals = s.renewalTotals.length ? s.renewalTotals.map(row => money(row.minor, row.currency)).join(' + ') : '—';
    const body = s.renewals.length ? `<table class="analyticsTable"><thead><tr><th>Renewal</th><th>Customer</th><th class="numeric">Amount</th></tr></thead><tbody>${s.renewals.map(row => `<tr><td><strong>${esc(shortDate(row.current_period_end))}</strong><span class="sub">${esc(row.source)} · ${esc(row.plan_name)}</span></td><td><a href="/admin/users/${esc(row.customer_id)}">${esc(row.name)}</a></td><td class="numeric">${esc(money(row.price_minor, row.currency))}</td></tr>`).join('')}</tbody></table>` : '<div class="analyticsEmpty">No automatic renewals are due in this forecast window.</div>';
    return analyticsCard('Revenue future', `Expected automatic renewals in the next ${s.forecastDays} day${s.forecastDays === 1 ? '' : 's'}`, body, { className: 'wide', stat: { value: totals, label: `${number(s.renewals.length)} renewals shown` } });
}

function recentPaymentsCard(s) {
    const rows = s.revenue.recent;
    const body = rows.length ? `<table class="analyticsTable"><thead><tr><th>Payment</th><th>Customer</th><th class="numeric">Amount</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${esc(row.provider === 'stripe' ? 'Stripe' : 'PayPal')}</strong><span class="sub">${esc(dateTime(row.createdAt))}</span></td><td>${esc(row.email || 'Provider customer')}</td><td class="numeric"><strong>${esc(money(row.minor, row.currency))}</strong></td></tr>`).join('')}</tbody></table>` : '<div class="analyticsEmpty">No successful provider payments in this period.</div>';
    return analyticsCard('Recent payments', `Successful payments · ${s.range.label}`, body, { className: 'narrow' });
}

function referrersCard(s) {
    const body = s.topReferrers.length ? `<table class="analyticsTable"><thead><tr><th>Customer</th><th class="numeric">Referrals</th><th class="numeric">Rewarded</th></tr></thead><tbody>${s.topReferrers.map(row => `<tr><td><a href="/admin/users/${esc(row.customer_id)}"><strong>${esc(row.name)}</strong></a></td><td class="numeric">${number(row.referrals)}</td><td class="numeric">${number(row.rewarded)}</td></tr>`).join('')}</tbody></table>` : '<div class="analyticsEmpty">No referral activity in this period.</div>';
    return analyticsCard('Top referrers', `Referral redemptions · ${s.range.label}`, body, { className: 'full' });
}

function renderDashboard(s) {
    const avgSession = s.period.playbackSessions ? s.period.playbackSeconds / s.period.playbackSessions : 0;
    const otherCurrencies = s.revenue.currencies.filter(row => row.currency !== s.revenue.primaryCurrency);
    return `<link rel="stylesheet" href="/css/admin-dashboard-analytics.css">
    <div class="analyticsDashboard">
        ${rangeControls(s.range)}
        ${setupCompact(s)}
        ${operationalAlerts(s)}
        <div class="analyticsKpis">
            ${kpi('Gross revenue', money(s.period.revenueMinor, s.period.revenueCurrency), otherCurrencies.length ? `plus ${otherCurrencies.length} other currenc${otherCurrencies.length === 1 ? 'y' : 'ies'}` : 'provider payments', s.period.delta.revenue)}
            ${kpi('New customers', number(s.period.newCustomers), `${number(s.current.customers)} total customers`, s.period.delta.newCustomers)}
            ${kpi('New subscriptions', number(s.period.newSubscriptions), `${number(s.period.trialStarts)} trial starts`, s.period.delta.newSubscriptions)}
            ${kpi('Active subscriptions', number(s.current.activeSubscriptions), 'live entitlement count')}
            ${kpi('Managed watch time', hours(s.period.playbackSeconds), `${hours(avgSession)} average / session`, s.period.delta.playbackSeconds)}
            ${kpi('Managed sessions', number(s.period.playbackSessions), `${number(s.period.uniqueViewers)} unique viewers`, s.period.delta.playbackSessions)}
            ${kpi('Live fleet streams', number(s.current.fleetStreams), `${number(s.current.managedStreams)} managed · live`)}
            ${kpi('Jellyfin users', number(s.current.jellyfinUsers), `${number(s.current.healthyServers)} / ${number(s.current.servers)} servers healthy · live`)}
        </div>

        <div class="analyticsSectionTitle"><h2>Business performance</h2><span>${esc(s.range.label)}</span></div>
        <div class="analyticsGrid">
            ${revenueCard(s)}
            ${customerGrowthCard(s)}
            ${playbackCard(s)}
            ${planMixCard(s)}
        </div>

        <div class="analyticsSectionTitle"><h2>Streaming operations</h2><span>live fleet + selected-period managed playback</span></div>
        <div class="analyticsGrid">
            ${serverLoadCard(s)}
            ${playbackMethodCard(s)}
            ${analyticsCard('Top streamers', `Managed customers · ${s.range.label}`, streamerTable(s), { className: 'third' })}
            ${analyticsCard('Top devices', `Managed playback sessions · ${s.range.label}`, deviceTable(s), { className: 'third' })}
            ${analyticsCard('Top content', `Most-started managed playback · ${s.range.label}`, contentTable(s), { className: 'third' })}
        </div>

        <div class="analyticsSectionTitle"><h2>Commerce</h2><span>payments, renewals and referrals</span></div>
        <div class="analyticsGrid">
            ${renewalsCard(s)}
            ${recentPaymentsCard(s)}
            ${referrersCard(s)}
        </div>
        <div class="analyticsFootnote">Historical streaming charts are intentionally limited to CAPTaINFiN-managed users because legacy Jellyfin playback is not retained in playback history. Live fleet stream/user totals include all Jellyfin users. Download and geographic analytics are not shown because CAPTaINFiN does not currently collect trustworthy history for those metrics.</div>
    </div>`;
}

module.exports = { renderDashboard, money, hours, barChart, areaChart, rangeControls };
