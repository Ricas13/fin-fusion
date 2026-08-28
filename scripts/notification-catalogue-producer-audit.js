'use strict';

const fs = require('fs');
const path = require('path');
const adminPolicy = require('../src/integrations/notification-admin-policy');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'src');
const cataloguePaths = [
    'db/migrations/000_database_baseline.sql',
    'db/migrations/014_support_ticket_notification_events.sql',
    'db/migrations/104_admin_activity_notification_catalogue.sql'
];
const retirementPath = 'db/migrations/037_notification_catalogue_runtime.sql';
const infrastructureOnly = new Set([
    'src/integrations/notification-dispatch.js',
    'src/platform/admin-notification-preferences.js',
    'src/platform/customer-communications.js',
    'src/platform/admin-personal-notification-preferences-v2.js'
]);
const retired = new Set([
    'account.announcement',
    'attention.created',
    'customer.created',
    'request.created',
    'security.alert',
    'customer.subscription.cancelled',
    'customer.subscription.requested',
    'customer.trial.requested',
    'customer.stremio.requested'
]);

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function relative(file) {
    return path.relative(root, file).split(path.sep).join('/');
}

function catalogueFromSql(sql) {
    const events = [];
    const insert = /INSERT\s+INTO\s+(?:public\.)?notification_preferences(?:\s*\([^;]*?\))?\s*VALUES\s*([\s\S]*?)(?=\bON\s+CONFLICT\b|;)/gi;
    let block;
    while ((block = insert.exec(sql))) {
        const tuple = /\(\s*'([a-z][a-z0-9_.-]+)'\s*,/gi;
        let match;
        while ((match = tuple.exec(block[1]))) events.push(match[1]);
    }
    return events;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const inserted = [...new Set(cataloguePaths.flatMap(file => catalogueFromSql(fs.readFileSync(path.join(root, file), 'utf8'))))].sort();
if (inserted.length !== 34) throw new Error(`Notification catalogue contract expected 34 historical entries; found ${inserted.length}.`);

const retirementSql = fs.readFileSync(path.join(root, retirementPath), 'utf8');
for (const eventType of retired) {
    if (!retirementSql.includes(`'${eventType}'`)) throw new Error(`Retired notification event is missing from ${retirementPath}: ${eventType}`);
}

const catalogue = inserted.filter(eventType => !retired.has(eventType));
if (catalogue.length !== 25) throw new Error(`Notification catalogue contract expected 25 live entries; found ${catalogue.length}.`);

const sources = walk(sourceRoot)
    .map(file => ({ file: relative(file), text: fs.readFileSync(file, 'utf8') }))
    .filter(row => !infrastructureOnly.has(row.file));

const rows = catalogue.map(eventType => {
    const literal = escapeRegex(eventType);
    const directPattern = new RegExp(`eventType\\s*:\\s*['\\"]${literal}['\\"]`);
    const direct = sources.filter(row => directPattern.test(row.text)).map(row => row.file);
    const references = sources.filter(row => row.text.includes(eventType)).map(row => row.file);
    const status = direct.length ? 'DIRECT' : references.length ? 'REFERENCE_ONLY' : 'MISSING';
    return { eventType, status, direct, references };
});

console.log(`notification catalogue producer contract: ${rows.length} live event types`);
for (const row of rows) {
    const files = row.direct.length ? row.direct : row.references;
    console.log(`${row.status.padEnd(14)} ${row.eventType}${files.length ? ` :: ${files.join(', ')}` : ''}`);
}

const invalid = rows.filter(row => row.status !== 'DIRECT');
if (invalid.length) {
    throw new Error(`Live notification events without direct runtime producers: ${invalid.map(row => `${row.eventType} (${row.status})`).join(', ')}`);
}

const expectedGroups = {
    'payment.chargeback': 'Money',
    'commercial.discount.redeemed': 'Money',
    'customer.registered': 'Access',
    'customer.claimed': 'Access',
    'customer.access.suspended': 'Access',
    'request.available': 'Growth',
    'login.customer.succeeded': 'Noise'
};
for (const [eventType, expected] of Object.entries(expectedGroups)) {
    const actual = adminPolicy.group(eventType);
    if (actual !== expected) throw new Error(`Admin notification group mismatch for ${eventType}: expected ${expected}, got ${actual}`);
}
for (const eventType of ['payment.chargeback','commercial.discount.redeemed','customer.registered','customer.claimed','customer.access.suspended']) {
    if (!adminPolicy.defaultEnabled(eventType)) throw new Error(`Admin notification should default on: ${eventType}`);
}
if (adminPolicy.defaultEnabled('login.customer.succeeded')) throw new Error('Customer login activity must default off as Noise.');

console.log(`summary: direct=${rows.length} retired=${retired.size} invalid=0`);

module.exports = { inserted, catalogue, retired, rows };
