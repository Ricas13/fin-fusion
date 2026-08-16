'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const deployScript = fs.readFileSync(path.join(root, 'scripts', 'deploy-production.sh'), 'utf8');
const prepareScript = path.join(root, 'scripts', 'prepare-production-env.js');
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

const syntax = spawnSync('bash', ['-n', path.join(root, 'scripts', 'deploy-production.sh')], { encoding: 'utf8' });
assert.strictEqual(syntax.status, 0, syntax.stderr || 'deploy-production.sh must pass bash -n');

for (const token of [
  'prepare-production-env.js --write',
  '--user "$(id -u):$(id -g)"',
  'docker compose config',
  'docker compose --profile recovery build',
  'BACKUP_DIR=/backups/predeploy',
  'recovery-tools npm run db:backup',
  'docker compose run --rm --no-deps migrate',
  'docker compose up -d --no-deps app automation-worker activity-worker backup-worker',
  'npm run verify:deployment'
]) {
  assert(deployScript.includes(token), `deployment script must contain ${token}`);
}
assert(gitignore.includes('.env.pre-runtime-roles-*.bak'), 'generated env safety copies must be ignored by git');

const order = [
  deployScript.indexOf('prepare-production-env.js --write'),
  deployScript.indexOf('docker compose config'),
  deployScript.indexOf('docker compose --profile recovery build'),
  deployScript.indexOf('recovery-tools npm run db:backup'),
  deployScript.indexOf('docker compose run --rm --no-deps migrate'),
  deployScript.indexOf('docker compose up -d --no-deps app automation-worker activity-worker backup-worker'),
  deployScript.indexOf('npm run verify:deployment')
];
assert(order.every((value, index) => value >= 0 && (index === 0 || value > order[index - 1])), 'deployment safety operations must remain in prepare -> config -> build -> encrypted backup -> migrate -> recreate -> verify order');
assert(!deployScript.includes('> "$backup"'), 'deployment helper must not create a raw plaintext pg_dump on the host');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captainfin-deploy-'));
try {
  const envFile = path.join(tempDir, '.env');
  fs.writeFileSync(envFile, 'POSTGRES_PASSWORD=owner-secret\nDATABASE_URL=postgres://steamfusion:owner-secret@postgres:5432/steamfusion\n', { mode: 0o600 });

  const generated = spawnSync(process.execPath, [prepareScript, '--write', `--env-file=${envFile}`], { encoding: 'utf8' });
  assert.strictEqual(generated.status, 0, generated.stderr || 'runtime credential generation must succeed');

  const backups = fs.readdirSync(tempDir).filter(name => name.startsWith('.env.pre-runtime-roles-') && name.endsWith('.bak'));
  assert.strictEqual(backups.length, 1, 'environment preparation must create exactly one safety copy when it mutates .env');
  assert.strictEqual(fs.statSync(path.join(tempDir, backups[0])).mode & 0o777, 0o600, 'environment safety copy must be owner-readable/writable only');

  const content = fs.readFileSync(envFile, 'utf8');
  const specs = [
    ['APP_DATABASE_URL', 'steamfusion_app'],
    ['AUTOMATION_DATABASE_URL', 'steamfusion_automation'],
    ['ACTIVITY_DATABASE_URL', 'steamfusion_activity'],
    ['BACKUP_DATABASE_URL', 'steamfusion_backup'],
    ['BACKUP_VERIFY_DATABASE_URL', 'steamfusion_backup_verify']
  ];
  const passwords = new Set();
  for (const [key, role] of specs) {
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
    assert(match, `${key} must be generated`);
    const url = new URL(match[1]);
    assert.strictEqual(decodeURIComponent(url.username), role, `${key} must use ${role}`);
    const password = decodeURIComponent(url.password);
    assert(password.length >= 24, `${key} must use a strong password`);
    assert.notStrictEqual(password, 'owner-secret', `${key} must not reuse the owner password`);
    assert(!passwords.has(password), `${key} must have a unique password`);
    passwords.add(password);
  }

  const before = fs.readFileSync(envFile, 'utf8');
  const checked = spawnSync(process.execPath, [prepareScript, '--check', `--env-file=${envFile}`], { encoding: 'utf8' });
  assert.strictEqual(checked.status, 0, checked.stderr || 'runtime credential check must succeed after generation');
  assert.strictEqual(fs.readFileSync(envFile, 'utf8'), before, '--check must never mutate the environment file');

  const badFile = path.join(tempDir, '.env.bad');
  fs.writeFileSync(badFile, `${before.replace(/^APP_DATABASE_URL=.*$/m, 'APP_DATABASE_URL=postgres://steamfusion_app:short@postgres:5432/steamfusion')}`);
  const bad = spawnSync(process.execPath, [prepareScript, '--check', `--env-file=${badFile}`], { encoding: 'utf8' });
  assert.notStrictEqual(bad.status, 0, 'weak existing runtime credentials must fail closed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('deployment tooling smoke: ok');
