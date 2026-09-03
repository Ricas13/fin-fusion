'use strict';

const assert = require('assert');
const db = require('../src/db');

assert.strictEqual(
  db.assertWebDatabaseRole({ nodeEnv: 'production', databaseUrl: 'postgres://steamfusion_app:secret@db/steamfusion' }),
  'steamfusion_app',
  'supported production web role must be accepted'
);

assert.throws(
  () => db.assertWebDatabaseRole({ nodeEnv: 'production', databaseUrl: 'postgres://steamfusion:owner-secret@db/steamfusion' }),
  /restricted steamfusion_app role/,
  'owner/deploy DATABASE_URL must never be accepted by the production web runtime'
);

assert.throws(
  () => db.assertWebDatabaseRole({ nodeEnv: 'production', databaseUrl: 'postgres://steamfusion_automation:secret@db/steamfusion' }),
  /restricted steamfusion_app role/,
  'a different runtime role must not be silently reused for the web process'
);

assert.strictEqual(
  db.assertWebDatabaseRole({ nodeEnv: 'development', databaseUrl: 'postgres://postgres:postgres@db/steamfusion' }),
  null,
  'development remains compatible with local owner credentials'
);

assert.strictEqual(
  db.assertWebDatabaseRole({ nodeEnv: 'production', databaseUrl: 'postgres://captainfin_web:secret@db/captainfin', expectedRole: 'captainfin_web' }),
  'captainfin_web',
  'advanced deployments may name an explicitly configured restricted web role'
);

assert.strictEqual(db.directWebRuntime(['node', '/srv/app/src/application.js']), false, 'path comparison must not guess a different checkout as this repository entrypoint');
assert.strictEqual(db.directWebRuntime(['node', require.resolve('../src/application.js')]), true, 'direct node src/application.js entrypoint must trigger production role validation');

console.log('production web database role smoke: ok');
