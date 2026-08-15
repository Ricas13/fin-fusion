'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');

function serviceBlock(name, nextName) {
    const start = compose.indexOf(`  ${name}:\n`);
    assert(start >= 0, `missing ${name} service`);
    const end = nextName ? compose.indexOf(`  ${nextName}:\n`, start + 1) : compose.length;
    assert(end > start, `could not isolate ${name} service`);
    return compose.slice(start, end);
}

const migrate = serviceBlock('migrate', 'app');
const app = serviceBlock('app', 'activity-worker');
const activity = serviceBlock('activity-worker', 'recovery-tools');

assert.match(migrate, /npm run db:migrate/, 'migrate service must run db:migrate');
assert.match(migrate, /npm run db:activity-role/, 'migrate service must refresh the restricted activity database role when configured');
assert.match(migrate, /npm run auth:bootstrap/, 'migrate service must bootstrap a native administrator when required');
assert(
    migrate.indexOf('npm run db:migrate') < migrate.indexOf('npm run db:activity-role'),
    'database migrations must complete before activity role grants are refreshed'
);
assert(
    migrate.indexOf('npm run db:activity-role') < migrate.indexOf('npm run auth:bootstrap'),
    'activity role grants must be refreshed before native administrator bootstrap'
);
assert.match(migrate, /postgres:\n\s+condition:\s+service_healthy/, 'migrate must wait for healthy postgres');
assert.match(migrate, /restart:\s+"no"/, 'migrate must be a one-shot service');

for (const [name, block] of [['app', app], ['activity-worker', activity]]) {
    assert.match(block, /migrate:\n\s+condition:\s+service_completed_successfully/, `${name} must wait for migrations and bootstrap`);
}

console.log('compose migration smoke: ok');
