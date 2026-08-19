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

// Each dashboard module registers the function that builds its render context
// (ctx = {range, data, reporting}) from a request, so the lazy-widget JSON
// endpoint can rebuild the same context a normal page load would use without
// admin-dashboard-layout.js needing a direct dependency on every dashboard module.
const contextBuilders = new Map();
function registerContextBuilder(dashboardKey, buildContext) {
    assertDashboardKey(dashboardKey);
    if (typeof buildContext !== 'function') throw new Error('buildContext must be a function');
    contextBuilders.set(dashboardKey, buildContext);
}
function getContextBuilder(dashboardKey) {
    assertDashboardKey(dashboardKey);
    return contextBuilders.get(dashboardKey) || null;
}

module.exports = { register, listWidgets, getWidget, registerContextBuilder, getContextBuilder, DASHBOARD_KEYS };
