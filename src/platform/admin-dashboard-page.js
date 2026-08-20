'use strict';

const csrf = require('../auth/csrf');
const { esc } = require('./admin-html');
const registry = require('./admin-dashboard-registry');
const layoutModule = require('./admin-dashboard-layout');
const widgets = require('./admin-dashboard-widgets');

// Shared body for every widget-driven dashboard: loads the admin's saved
// layout, merges it with the registry, and renders EVERY registered widget
// -- not just the visible ones. Hidden widgets still get a DOM card (with
// the widgetHidden class, so CSS keeps them invisible) instead of being
// omitted entirely: the client's currentWidgets() reads layout state from
// the DOM, so a hidden widget with no card would vanish from every future
// save, and the widget picker would have nothing to un-hide. Both hidden
// and lazy widgets get a skeleton + a data-lazy-src fragment URL instead of
// a server render, so hiding widgets doesn't cost anything server-side.
async function renderWidgetGrid(dashboardKey, req, ctx) {
    const saved = await layoutModule.getLayout(req.session.authUserId, dashboardKey);
    const merged = layoutModule.mergeWithDefaults(dashboardKey, saved);
    const body = (await Promise.all(merged.map(async row => {
        const spec = registry.getWidget(dashboardKey, row.widget_key);
        if (!spec) return '';
        const isHidden = row.visible === false;
        const deferRender = spec.lazy || isHidden;
        let html;
        if (deferRender) {
            html = widgets.loadingSkeleton();
        } else {
            try {
                html = await spec.render(ctx);
            } catch (error) {
                console.error(`Dashboard widget "${row.widget_key}" failed to render:`, error.message);
                html = widgets.errorState('This widget could not be loaded.');
            }
        }
        const lazyAttr = deferRender ? ` data-lazy-src="/admin/api/dashboard/${encodeURIComponent(dashboardKey)}/widget/${encodeURIComponent(row.widget_key)}"` : '';
        return widgets.widgetShell({ key: row.widget_key, title: row.title, subtitle: row.subtitle }, `<div class="widgetBody"${lazyAttr}>${html}</div>`, { span: row.span, hidden: isHidden });
    }))).join('');
    const picker = registry.listWidgets(dashboardKey).map(spec => {
        const current = merged.find(row => row.widget_key === spec.key);
        return `<button type="button" class="widgetPickerItem ${current?.visible !== false ? 'active' : ''}" data-widget-picker-item="${esc(spec.key)}">${esc(spec.title)}</button>`;
    }).join('');
    return `
        <link rel="stylesheet" href="/css/admin-dashboard-analytics.css">
        <div class="dashboardCustomizeBar"><button type="button" class="button secondary btn-sm" data-dashboard-customize-toggle>Customize dashboard</button></div>
        <div class="notice error widgetHidden" data-dashboard-layout-error role="alert"></div>
        <div class="widgetPicker widgetHidden" data-widget-picker><h3>Show/hide widgets</h3><div class="widgetPickerList">${picker}</div><div class="buttonRow" style="margin-top:10px"><button type="button" class="button secondary btn-sm" data-dashboard-reset>Restore defaults</button></div></div>
        <div class="analyticsGrid" data-dashboard-key="${esc(dashboardKey)}" data-csrf-token="${esc(csrf.token(req))}">${body}</div>
        <script src="/js/admin-dashboard-widgets.js" defer></script>
    `;
}

module.exports = { renderWidgetGrid };
