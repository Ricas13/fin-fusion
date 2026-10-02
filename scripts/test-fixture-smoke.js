'use strict';

const assert = require('assert');
const fixture = require('./test-fixture');

assert.strictEqual(typeof fixture.runDbSmoke, 'function');
assert.strictEqual(typeof fixture.withRollback, 'function');
assert.strictEqual(typeof fixture.withTimezones, 'function');
assert.strictEqual(typeof fixture.withEnv, 'function');
assert.strictEqual(typeof fixture.unique, 'function');
assert.strictEqual(typeof fixture.deferred, 'function');
assert.strictEqual(typeof fixture.barrier, 'function');
assert.strictEqual(typeof fixture.installModuleMock, 'function');

(async () => {
  const before = process.env.CAPTAINFIN_FIXTURE_TEST;
  await fixture.withEnv({ CAPTAINFIN_FIXTURE_TEST: 'inside' }, async () => {
    assert.strictEqual(process.env.CAPTAINFIN_FIXTURE_TEST, 'inside');
  });
  assert.strictEqual(process.env.CAPTAINFIN_FIXTURE_TEST, before);

  const a = fixture.unique('fixture');
  const b = fixture.unique('fixture');
  assert.notStrictEqual(a, b);
  assert(a.startsWith('fixture-') && b.startsWith('fixture-'));

  const wait = fixture.barrier(2);
  let passed = 0;
  await Promise.all([
    wait().then(() => { passed += 1; }),
    wait().then(() => { passed += 1; })
  ]);
  assert.strictEqual(passed, 2);

  console.log('test fixture smoke: ok');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
