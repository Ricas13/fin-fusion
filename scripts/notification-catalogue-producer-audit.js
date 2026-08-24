'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'src');
const migrationPaths = [
    'db/migrations/000_database_baseline.sql',
    'db/migrations/014_support_ticket_notification_events.sql'
];
const infrastructureOnly = new Set([
    'src/integrations/notification-dispatch.js',
    'src/platform/admin-notification-preferences.js',
    'src/platform/customer-communications.js',
    'src/platform/admin-personal-notification-preferences-v2.js'
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
    const insert = /INSERT\s+INTO\s+(?:public\.)?notification_preferences\s*\([^;]*?\)\s*VALUES\s*([\s\S]*?)(?=\bON\s+CONFLICT\b|;)/gi;
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

const catalogue = [...new Set(migrationPaths.flatMap(file => catalogueFromSql(fs.readFileSync(path.join(root, file), 'utf8'))))].sort();
if (!catalogue.length) throw new Error('Notification catalogue audit could not discover any configured event types.');

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

console.log(`notification catalogue producer audit: ${rows.length} event types`);
for (const row of rows) {
    const files = row.direct.length ? row.direct : row.references;
    console.log(`${row.status.padEnd(14)} ${row.eventType}${files.length ? ` :: ${files.join(', ')}` : ''}`);
}

const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
}, {});
console.log(`summary: direct=${counts.DIRECT || 0} reference_only=${counts.REFERENCE_ONLY || 0} missing=${counts.MISSING || 0}`);

// This first pass is intentionally diagnostic. The follow-up cleanup will turn
// the final classification into a hard regression contract once intentional
// manual/alias events have been separated from genuinely producible events.
