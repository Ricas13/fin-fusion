'use strict';

const { query } = require('../db');

function scanKey(value) {
    const key = String(value || '').trim();
    if (!key || key.length > 120 || !/^[a-z0-9_.:-]+$/i.test(key)) {
        throw new Error('A valid automation scan key is required.');
    }
    return key;
}

function boundedInteger(value, fallback, min = 1, max = 1000) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

async function load(scan, queryFn = query) {
    const result = await queryFn(
        'SELECT cursor_text FROM automation_scan_cursors WHERE scan_key=$1',
        [scanKey(scan)]
    );
    return result.rows[0]?.cursor_text || null;
}

async function save(scan, cursor, queryFn = query) {
    const value = cursor == null || String(cursor).trim() === '' ? null : String(cursor).trim().slice(0, 300);
    await queryFn(`
        INSERT INTO automation_scan_cursors(scan_key,cursor_text,updated_at)
        VALUES($1,$2,NOW())
        ON CONFLICT(scan_key) DO UPDATE SET cursor_text=EXCLUDED.cursor_text,updated_at=NOW()
    `, [scanKey(scan), value]);
    return value;
}

async function clear(scan, queryFn = query) {
    return save(scan, null, queryFn);
}

async function mapSettledBounded(items, concurrency, worker) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return [];
    const width = boundedInteger(concurrency, 1, 1, Math.min(32, rows.length));
    const settled = new Array(rows.length);
    let index = 0;
    const runners = Array.from({ length: width }, async () => {
        while (true) {
            const current = index++;
            if (current >= rows.length) return;
            try {
                settled[current] = { status: 'fulfilled', value: await worker(rows[current], current) };
            } catch (reason) {
                settled[current] = { status: 'rejected', reason };
            }
        }
    });
    await Promise.all(runners);
    return settled;
}

module.exports = {
    scanKey,
    boundedInteger,
    load,
    save,
    clear,
    mapSettledBounded
};
