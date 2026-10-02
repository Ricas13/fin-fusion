'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const { TAGS, normalizeTags, suitesForTags, commandsForTags } = require('./check-manifest');

const required = ['fast','db','billing','access','browser','security'];
assert.deepStrictEqual(Object.keys(TAGS).sort(), required.sort(), 'manifest must expose the required test tags');

for (const [tag, suites] of Object.entries(TAGS)) {
  assert(suites.length > 0, `${tag} tag must contain at least one suite`);
  for (const suite of suites) {
    assert(pkg.scripts[suite], `${tag} tag references unknown npm script ${suite}`);
  }
  assert(commandsForTags([tag]).length > 0, `${tag} tag must expand to runnable commands`);
}

assert.strictEqual(pkg.scripts.check, 'npm run check:tag -- fast', 'default check entrypoint must use the canonical tagged manifest');
for (const tag of ['billing','access','browser','security']) {
  assert.strictEqual(pkg.scripts[`check:${tag}`], `npm run check:tag -- ${tag}`, `check:${tag} must be a stable tagged-suite alias`);
}
assert.deepStrictEqual(normalizeTags(['ACCESS','billing,access']), ['access','billing']);
assert.throws(() => normalizeTags(['unknown']), /Unknown check tag/);

const combined = commandsForTags(['access','billing']);
assert.strictEqual(combined.length, new Set(combined).size, 'multi-tag execution must deduplicate overlapping commands');
assert(combined.some(command => command.includes('access-integrity-db-smoke.js')),
  'access tag must include DB-backed access integrity coverage');
assert(combined.some(command => command.includes('state-machine-invariants-db-smoke.js')),
  'access tag must include lifecycle state-machine DB coverage');
assert(combined.some(command => command.includes('billing-lifecycle-smoke.js')),
  'billing tag must include billing lifecycle DB coverage');
assert(combined.some(command => command.includes('provider-operation-recovery-db-smoke.js')),
  'billing tag must include provider-operation recovery DB coverage');

const security = commandsForTags(['security']).join('\n');
for (const script of [
  'security-boundary-hardening-smoke.js',
  'admin-mutation-rate-limit-smoke.js',
  'runtime-db-isolation-smoke.js'
]) {
  assert(security.includes(script), `security tag must include ${script}`);
}

const browser = commandsForTags(['browser']).join('\n');
assert(browser.includes('admin-accessibility-mobile-smoke.js')
  && browser.includes('dashboard-business-layout-smoke.js')
  && browser.includes('installer-smoke.js'),
  'browser tag must include admin UI/dashboard and clean-install-adjacent coverage');

const runner = fs.readFileSync(path.join(__dirname, 'run-tagged-checks.js'), 'utf8');
assert(runner.includes("require('./run-check-suite')") && runner.includes('commandsForTags(tags)'),
  'tagged runner must reuse canonical suite expansion/execution rather than own a second command parser');

console.log('tagged check manifest smoke: ok');
