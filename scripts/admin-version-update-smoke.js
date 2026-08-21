'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const release = require('../src/platform/release-status');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const dockerfile = read('Dockerfile');
const deploy = read('scripts/deploy-production.sh');
const nav = read('src/platform/admin-nav.js');
const routes = read('src/platform/admin-route-composition.js');
const system = read('src/platform/admin-system.js');
const shell = read('src/platform/admin-html-core-base.js');
const shellWrapper = read('src/platform/admin-html-core.js');
const indicator = read('public/js/admin-release-status.js');
const capabilityCss = read('public/css/admin-capability.css');
const releaseCss = read('public/css/admin-release-status.css');

const sha = 'a'.repeat(40);
const metadata = release.buildMetadata({ CAPTAINFIN_BUILD_SHA: sha, CAPTAINFIN_BUILD_TIME: '2026-08-22T00:00:00Z' });
assert.strictEqual(metadata.sha, sha, 'build metadata must preserve an exact 40-character commit SHA');
assert.strictEqual(metadata.builtAt, '2026-08-22T00:00:00.000Z', 'build time must normalize to ISO');
assert(metadata.version, 'package version must be exposed');
assert.strictEqual(release.normalizeSha('not-a-sha'), '', 'invalid build SHAs must not be trusted');
assert.strictEqual(release.checkingEnabled({ NODE_ENV: 'test' }), false, 'test environments must never depend on GitHub update checks');
assert.strictEqual(release.checkingEnabled({ NODE_ENV: 'production', CAPTAINFIN_UPDATE_CHECK_ENABLED: 'false' }), false, 'operators must be able to disable update checks');
assert.strictEqual(release.checkingEnabled({ NODE_ENV: 'production' }), true, 'production update checking should be enabled by default');
assert.strictEqual(release.stateFromComparison('identical'), 'current');
assert.strictEqual(release.stateFromComparison('ahead'), 'update_available', 'main ahead of the installed build means an update is available');
assert.strictEqual(release.stateFromComparison('behind'), 'custom_build', 'a build ahead of main must not be called outdated');
assert.strictEqual(release.stateFromComparison('diverged'), 'custom_build', 'diverged builds must be identified instead of falsely offering an update');

const publicValue = release.publicStatus({
  state: 'update_available',
  local: metadata,
  upstreamSha: 'b'.repeat(40),
  upstreamAt: '2026-08-22T01:00:00.000Z',
  checkedAt: '2026-08-22T01:01:00.000Z',
  compareUrl: 'https://github.com/Ricas13/fin-fusion/compare/example'
});
assert.strictEqual(publicValue.buildShort, 'aaaaaaaa');
assert.strictEqual(publicValue.upstreamShort, 'bbbbbbbb');
assert.strictEqual(publicValue.label, 'Update available');
assert(!Object.prototype.hasOwnProperty.call(publicValue, 'local'), 'status JSON must expose a deliberately small public shape');

for (const token of ['ARG CAPTAINFIN_BUILD_SHA=unknown', 'ARG CAPTAINFIN_BUILD_TIME=unknown', 'CAPTAINFIN_BUILD_SHA=${CAPTAINFIN_BUILD_SHA}', 'CAPTAINFIN_BUILD_TIME=${CAPTAINFIN_BUILD_TIME}']) {
  assert(dockerfile.includes(token), `Docker image must embed ${token}`);
}
for (const token of ['CAPTAINFIN_BUILD_SHA="$(git rev-parse HEAD)"', '--build-arg CAPTAINFIN_BUILD_SHA=', '--build-arg CAPTAINFIN_BUILD_TIME=']) {
  assert(deploy.includes(token), `production deploy must preserve build identity via ${token}`);
}
assert(nav.includes("['system','System','/admin/system']"), 'Settings navigation must expose the System page');
assert(routes.includes("createAdminSystemRouter"), 'admin route composition must mount the System page');
assert(system.includes("router.get('/admin/system/status.json'"), 'admin shell must have a same-origin status endpoint');
assert(system.includes("router.post('/admin/system/check'"), 'admins must be able to request a fresh update check');
assert(system.includes('csrf.verify(req)'), 'manual update checks must preserve normal admin POST CSRF protection');
assert(system.includes('bash update.sh'), 'System page must direct operators to the supported host updater');
assert(!/child_process|exec\(|spawn\(/.test(system), 'System UI must never gain host command execution');
assert(shell.includes('data-release-status'), 'admin shell must show the running application version');
assert(shell.includes("require('../../package.json')"), 'shell version must come from package metadata rather than duplicated text');
assert(shellWrapper.includes('/js/admin-release-status.js'), 'release indicator must progressively enhance without blocking page render');
assert(indicator.includes("fetch('/admin/system/status.json'"), 'browser indicator must only call the same-origin admin endpoint');
assert(!indicator.includes('api.github.com'), 'browser JavaScript must not call GitHub directly');
assert(capabilityCss.includes("@import url('/css/admin-release-status.css')"), 'release status CSS must load through the existing admin capability entrypoint');
for (const token of ['.adminReleaseLink', '.systemReleaseGrid', '.systemUpdateCommand', '@media(max-width:620px)']) {
  assert(releaseCss.includes(token), `release status styles must include ${token}`);
}

console.log('admin version/update smoke: ok');
