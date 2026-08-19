'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/platform/admin-dashboard-registry');
const layout = require('../src/platform/admin-dashboard-layout');

registry.register('main', 'smokeWidgetA', { title: 'Smoke A', defaultOrder: 1, defaultSpan: 6, render: async () => '<p>a</p>' });
registry.register('main', 'smokeWidgetB', { title: 'Smoke B', defaultOrder: 2, defaultSpan: 4, render: async () => '<p>b</p>' });

async function seedAdmin(suffix) {
    const inserted = await query(
        `INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','admin',TRUE) RETURNING id`,
        [`dashboard-layout-${suffix}`]
    );
    return inserted.rows[0].id;
}

async function main() {
    const suffix = crypto.randomBytes(5).toString('hex');
    const adminA = await seedAdmin(`a-${suffix}`);
    const adminB = await seedAdmin(`b-${suffix}`);

    // Defaults: no saved rows -> registry order/defaults.
    const defaults = layout.mergeWithDefaults('main', []);
    assert.deepStrictEqual(defaults.map(w => w.widget_key), ['smokeWidgetA', 'smokeWidgetB'], 'unsaved dashboard must fall back to registry defaults in order');
    assert.strictEqual(defaults[0].span, 6, 'default span must come from the registry');

    // Save a custom layout for admin A: reordered, resized, one hidden.
    await layout.saveLayout(adminA, 'main', [
        { widgetKey: 'smokeWidgetB', position: 0, span: 8, visible: true, config: { limit: 5 } },
        { widgetKey: 'smokeWidgetA', position: 1, span: 4, visible: false, config: {} }
    ]);

    const savedA = await layout.getLayout(adminA, 'main');
    assert.strictEqual(savedA.length, 2, 'both widgets must be persisted');
    const mergedA = layout.mergeWithDefaults('main', savedA);
    assert.strictEqual(mergedA[0].widget_key, 'smokeWidgetB', 'reorder must round-trip');
    assert.strictEqual(mergedA[0].span, 8, 'resize must round-trip');
    assert.strictEqual(mergedA[0].config.limit, 5, 'config JSON must round-trip');
    assert.strictEqual(mergedA[1].visible, false, 'hidden widget must stay hidden after reload');

    // Admin B must be completely unaffected by admin A's save.
    const savedB = await layout.getLayout(adminB, 'main');
    assert.strictEqual(savedB.length, 0, "one admin's saved layout must never affect another admin's rows");
    const mergedB = layout.mergeWithDefaults('main', savedB);
    assert.deepStrictEqual(mergedB.map(w => w.visible), [true, true], "admin B must still see registry defaults, not admin A's hides");

    // Reset must clear rows and fall back to defaults.
    await layout.resetLayout(adminA, 'main');
    const afterReset = await layout.getLayout(adminA, 'main');
    assert.strictEqual(afterReset.length, 0, 'reset must delete all saved rows for that dashboard');
    const mergedAfterReset = layout.mergeWithDefaults('main', afterReset);
    assert.strictEqual(mergedAfterReset[0].widget_key, 'smokeWidgetA', 'reset must fall back to registry default order');

    // Validation: unknown widget key and out-of-range span must be rejected.
    let unknownWidgetRejected = false;
    try {
        await layout.saveLayout(adminA, 'main', [{ widgetKey: 'doesNotExist', position: 0, span: 6, visible: true }]);
    } catch (error) {
        unknownWidgetRejected = /Unknown widget/.test(error.message);
    }
    assert(unknownWidgetRejected, 'saveLayout must reject an unknown widget key');

    let badSpanRejected = false;
    try {
        await layout.saveLayout(adminA, 'main', [{ widgetKey: 'smokeWidgetA', position: 0, span: 7, visible: true }]);
    } catch (error) {
        badSpanRejected = /Invalid span/.test(error.message);
    }
    assert(badSpanRejected, 'saveLayout must reject an out-of-range span');

    let unknownDashboardRejected = false;
    try {
        await layout.saveLayout(adminA, 'bogus', [{ widgetKey: 'smokeWidgetA', position: 0, span: 6, visible: true }]);
    } catch (error) {
        unknownDashboardRejected = true;
    }
    assert(unknownDashboardRejected, 'saveLayout must reject an unknown dashboard key');

    console.log('admin dashboard layout persistence smoke: ok');
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
