'use strict';

const DASHBOARD_KEYS = ['main', 'users', 'commerce', 'servers'];
const registry = new Map(DASHBOARD_KEYS.map(key => [key, new Map()]));

function assertDashboardKey(dashboardKey) {
    if (!registry.has(dashboardKey)) throw new Error(`Unknown dashboard key: ${dashboardKey}`);
}

/**
 * spec = {
 *   title, subtitle,
 *   defaultSpan (one of admin-dashboard-widgets.SPAN_VALUES),
 *   defaultOrder (integer, registration order used if omitted),
 *   allowedTimeframes (array of range keys, or undefined for none),
 *   lazy (boolean, defer server render to a client-side fetch),
 *   render: async (ctx) => htmlString
 * }
 */
function register(dashboardKey, widgetKey, spec) {
    assertDashboardKey(dashboardKey);
    if (!widgetKey || typeof widgetKey !== 'string') throw new Error('widgetKey is required');
    if (typeof spec?.render !== 'function') throw new Error(`Widget ${dashboardKey}/${widgetKey} is missing a render function`);
    const dashboard = registry.get(dashboardKey);
    dashboard.set(widgetKey, {
        key: widgetKey,
        title: spec.title || widgetKey,
        subtitle: spec.subtitle || '',
        defaultSpan: spec.defaultSpan || 6,
        defaultOrder: spec.defaultOrder ?? dashboard.size,
        allowedTimeframes: spec.allowedTimeframes || null,
        lazy: Boolean(spec.lazy),
        render: spec.render
    });
}

function listWidgets(dashboardKey) {
    assertDashboardKey(dashboardKey);
    return [...registry.get(dashboardKey).values()].sort((a, b) => a.defaultOrder - b.defaultOrder);
}

function getWidget(dashboardKey, widgetKey) {
    assertDashboardKey(dashboardKey);
    return registry.get(dashboardKey).get(widgetKey) || null;
}

module.exports = { register, listWidgets, getWidget, DASHBOARD_KEYS };
