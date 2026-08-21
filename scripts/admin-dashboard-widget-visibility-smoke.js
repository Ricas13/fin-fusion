'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('admin dashboard widget visibility smoke')) process.exit(0);

// Regression coverage for a real bug: renderWidgetGrid() used to omit hidden
// widgets from the DOM entirely, so the client's currentWidgets() (which
// reads layout state straight off the DOM) could never see them again --
// re-showing a hidden widget from the picker did nothing, and worse, ANY
// save made while a widget was hidden silently dropped it from persistence
// (saveLayout() is a full replace, not a patch), so an unrelated reorder or
// resize would make a "hidden" widget reappear on the next reload.
//
// The fix renders every registered widget as a DOM card always (hidden ones
// get the widgetHidden class + a lazy fragment src instead of a full
// render), so the client always has a complete, accurate picture of every
// widget's visibility to send back on save. This test exercises that
// contract at the two layers this project's tests can reach without a
// browser: the server-side full-replace persistence semantics in
// admin-dashboard-layout.js, and the DOM shape renderWidgetGrid() actually
// emits for a hidden widget.

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/platform/admin-dashboard-registry');
const layout = require('../src/platform/admin-dashboard-layout');
const { renderWidgetGrid } = require('../src/platform/admin-dashboard-page');

registry.register('main', 'visibilitySmokeA', { title: 'Visibility Smoke A', defaultOrder: 1, defaultSpan: 6, render: async () => '<p>a</p>' });
registry.register('main', 'visibilitySmokeB', { title: 'Visibility Smoke B', defaultOrder: 2, defaultSpan: 6, render: async () => '<p>b</p>' });
registry.register('main', 'visibilitySmokeC', { title: 'Visibility Smoke C', defaultOrder: 3, defaultSpan: 4, render: async () => '<p>c</p>' });

async function seedAdmin(suffix) {
    const inserted = await query(
        `INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','admin',TRUE) RETURNING id`,
        [`dashboard-visibility-${suffix}`]
    );
    return inserted.rows[0].id;
}

// What the FIXED client's currentWidgets() sends: every widget the merged
// layout knows about, in DOM order, each carrying its own visible flag --
// never just the ones currently on screen.
function asSaveItems(mergedRows) {
    return mergedRows.map((row, index) => ({
        widgetKey: row.widget_key,
        position: index,
        span: row.span,
        visible: row.visible,
        config: row.config || {}
    }));
}

async function reload(adminId, dashboardKey) {
    const saved = await layout.getLayout(adminId, dashboardKey);
    return layout.mergeWithDefaults(dashboardKey, saved);
}

async function main() {
    const suffix = crypto.randomBytes(5).toString('hex');
    const adminId = await seedAdmin(suffix);

    // --- Scenario 1: hide -> save -> reload -> unhide -> save -> reload ---
    let state = await reload(adminId, 'main');
    assert.deepStrictEqual(state.map(w => w.visible), [true, true, true], 'starting state must be the registry defaults, all visible');

    state = state.map(row => row.widget_key === 'visibilitySmokeA' ? { ...row, visible: false } : row);
    await layout.saveLayout(adminId, 'main', asSaveItems(state));

    state = await reload(adminId, 'main');
    assert.strictEqual(state.find(w => w.widget_key === 'visibilitySmokeA').visible, false, 'A must be hidden after the first reload');

    state = state.map(row => row.widget_key === 'visibilitySmokeA' ? { ...row, visible: true } : row);
    await layout.saveLayout(adminId, 'main', asSaveItems(state));

    state = await reload(adminId, 'main');
    assert.strictEqual(state.find(w => w.widget_key === 'visibilitySmokeA').visible, true, 'A must be visible again after being un-hidden and saved');
    assert.strictEqual(state.find(w => w.widget_key === 'visibilitySmokeB').visible, true, 'B must be unaffected by A being hidden and re-shown');
    assert.strictEqual(state.find(w => w.widget_key === 'visibilitySmokeC').visible, true, 'C must be unaffected by A being hidden and re-shown');

    // --- Scenario 2: hide A -> reload -> reorder B -> save -> reload -> A still hidden ---
    await layout.resetLayout(adminId, 'main');
    state = await reload(adminId, 'main');
    state = state.map(row => row.widget_key === 'visibilitySmokeA' ? { ...row, visible: false } : row);
    await layout.saveLayout(adminId, 'main', asSaveItems(state));

    // Reload: this is the full DOM state a real browser would now have,
    // A included (hidden) -- this is exactly the array the fixed client's
    // currentWidgets() would produce by reading every card, visible or not.
    state = await reload(adminId, 'main');
    assert.strictEqual(state.find(w => w.widget_key === 'visibilitySmokeA').visible, false, 'A must still be hidden right after reload, before any further edits');

    // Reorder B to the front. Nothing about A's visibility is touched here.
    const bIndex = state.findIndex(w => w.widget_key === 'visibilitySmokeB');
    const [bRow] = state.splice(bIndex, 1);
    state.unshift(bRow);
    await layout.saveLayout(adminId, 'main', asSaveItems(state));

    state = await reload(adminId, 'main');
    assert.strictEqual(state[0].widget_key, 'visibilitySmokeB', 'the reorder itself must have taken effect');
    assert.strictEqual(state.find(w => w.widget_key === 'visibilitySmokeA').visible, false, 'A must STILL be hidden after an unrelated reorder+save -- this is the exact regression: a full-replace save that omitted A used to silently un-hide it');

    // --- Rendering layer: a hidden widget must still get a real DOM card ---
    await layout.resetLayout(adminId, 'main');
    await layout.saveLayout(adminId, 'main', asSaveItems(
        (await reload(adminId, 'main')).map(row => row.widget_key === 'visibilitySmokeA' ? { ...row, visible: false } : row)
    ));
    const req = { session: { authUserId: adminId }, query: {} };
    const html = await renderWidgetGrid('main', req, { data: {} });
    assert(html.includes('data-widget-key="visibilitySmokeA"'), 'a hidden widget must still be rendered as a DOM card, not omitted');
    const cardMatchA = html.match(/<section class="analyticsCard widgetCard[^"]*"[^>]*data-widget-key="visibilitySmokeA"/);
    assert(cardMatchA && / widgetHidden/.test(cardMatchA[0]), "the hidden widget's card must carry the widgetHidden class so CSS keeps it invisible");
    const cardMatchB = html.match(/<section class="analyticsCard widgetCard[^"]*"[^>]*data-widget-key="visibilitySmokeB"/);
    assert(cardMatchB && !/ widgetHidden/.test(cardMatchB[0]), 'a visible widget must not be marked widgetHidden');

    console.log('admin dashboard widget visibility smoke: ok');
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
