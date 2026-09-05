'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const core = read('src/platform/admin-html-core.js');
const controller = read('public/js/admin-filter-bars.js');
const css = read('public/css/admin-filter-bars.css');
const plans = read('src/platform/admin-plans-list.js');
const events = read('src/platform/admin-events.js');
const customers = read('src/platform/admin-customers-list.js');

assert(core.includes('/css/admin-filter-bars.css'), 'canonical admin shell must load shared filter styles');
assert(core.includes('/js/admin-filter-bars.js'), 'canonical admin shell must load shared filter behavior');
assert(controller.includes('eligibleGetForms'), 'shared filter controller must discover admin GET filter forms');
assert(controller.includes("String(form.method || 'get').toLowerCase() !== 'get'"), 'shared filter controller must reject mutation forms');
assert(controller.includes("form.matches('.adminQuickFind,[data-native-submit=\"true\"]')"), 'command/search and explicitly native forms must remain outside auto-filter behavior');
assert(controller.includes("control.addEventListener('change', () => requestFilterSubmit(form))"), 'select/date/toggle filters must apply immediately');
assert(controller.includes("control.addEventListener('input', () => scheduleFilterSubmit(form))"), 'text filters must use debounced auto-apply');
assert(controller.includes('const TEXT_DEBOUNCE_MS = 550'), 'text filter debounce must remain deliberate and short');
assert(controller.includes("more.textContent = 'More filters'"), 'secondary filters must use the shared expandable control where large datasets still need them');
assert(controller.includes("primary: ['q', 'service', 'status', 'plan', 'server']"), 'Customers must retain its deliberate high-frequency first row');
assert(controller.includes("/^(apply|filter|search)/i"), 'enhanced filter forms must remove redundant submit buttons');
assert(css.includes('flex-wrap:nowrap'), 'desktop filter toolbar must remain one compact row');
assert(css.includes('.adminFilterAdvanced[hidden]'), 'secondary filter panel must be collapsible');
assert(!plans.includes('data-plan-filters') && !plans.includes('data-plan-search') && !plans.includes('admin-plans-table.js'), 'Plans must not render filtering UI for the deliberately small catalogue');
assert(plans.includes("href=\"/admin/plans?archived=1\""), 'Plans must retain a compact archived-plan route instead of using filters to hide retired versions');
assert(events.includes('method="get" action="/admin/events"') && events.includes('Filter history'), 'Audit history must retain a no-JS GET fallback for the shared enhancer');
assert(customers.includes('compactFilterForm') && customers.includes('>Apply<'), 'Customers must retain a no-JS GET fallback while the shared enhancer owns the interactive UI');

console.log('global admin filter-bar smoke: ok');
