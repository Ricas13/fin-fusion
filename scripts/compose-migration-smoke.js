'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');

function serviceBlock(name) {
    const marker = `  ${name}:\n`;
    const start = compose.indexOf(marker);
    assert(start >= 0, `missing ${name} service`);
    const rest = compose.slice(start + marker.length);
    const next = rest.search(/^  [a-zA-Z0-9][a-zA-Z0-9_-]*:\n/m);
    return next < 0 ? compose.slice(start) : compose.slice(start, start + marker.length + next);
}

const migrate = serviceBlock('migrate');
assert.match(migrate, /npm run db:migrate/, 'migrate service must run db:migrate');
assert.match(migrate, /npm run db:runtime-roles/, 'migrate service must refresh isolated runtime database roles');
assert.match(migrate, /npm run auth:bootstrap/, 'migrate service must bootstrap a native administrator when required');
assert(
    migrate.indexOf('npm run db:migrate') < migrate.indexOf('npm run db:runtime-roles'),
    'database migrations must complete before runtime role grants are refreshed'
);
assert(
    migrate.indexOf('npm run db:runtime-roles') < migrate.indexOf('npm run auth:bootstrap'),
    'runtime role grants must be refreshed before native administrator bootstrap'
);
assert.match(migrate, /postgres:\n\s+condition:\s+service_healthy/, 'migrate must wait for healthy postgres');
assert.match(migrate, /restart:\s+"no"/, 'migrate must be a one-shot service');
assert.match(migrate, /env_file:\s*\.env/, 'only the privileged one-shot migrate service may consume the complete .env');

for (const name of ['app', 'automation-worker', 'activity-worker', 'backup-worker']) {
    const block = serviceBlock(name);
    assert.match(block, /migrate:\n\s+condition:\s+service_completed_successfully/, `${name} must wait for migrations and role bootstrap`);
    assert(!/\benv_file\s*:/.test(block), `${name} must not inherit the privileged .env wholesale`);
}

console.log('compose migration smoke: ok');
