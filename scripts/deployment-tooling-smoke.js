'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const deployScript = fs.readFileSync(path.join(root, 'scripts', 'deploy-production.sh'), 'utf8');
const prepareScript = path.join(root, 'scripts', 'prepare-production-env.js');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const verifyDeployment = fs.readFileSync(path.join(root, 'scripts', 'verify-deployment.js'), 'utf8');
const backupWorker = fs.readFileSync(path.join(root, 'scripts', 'backup-worker.js'), 'utf8');
const application = fs.readFileSync(path.join(root, 'src', 'application.js'), 'utf8');
const customerRateLimit = fs.readFileSync(path.join(root, 'src', 'security', 'customer-rate-limit.js'), 'utf8');
const watchdogPath = path.join(root, 'scripts', 'availability-watchdog.sh');
const watchdogInstallerPath = path.join(root, 'scripts', 'install-availability-watchdog.sh');
const watchdog = fs.readFileSync(watchdogPath, 'utf8');
const watchdogInstaller = fs.readFileSync(watchdogInstallerPath, 'utf8');
const composeRuntimePath = path.join(root, 'scripts', 'lib', 'compose-runtime.sh');
const composeRuntime = fs.readFileSync(composeRuntimePath, 'utf8');
const recovery = fs.readFileSync(path.join(root, 'recovery.sh'), 'utf8');
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');

function bashPath() {
  const candidates = [
    process.env.BASH_PATH,
    'bash',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'bash') {
      if (process.platform !== 'win32') return candidate;
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'bash';
}

for (const scriptPath of [
  path.join(root, 'scripts', 'deploy-production.sh'),
  watchdogPath,
  watchdogInstallerPath,
  composeRuntimePath,
  path.join(root, 'recovery.sh')
]) {
  const syntax = spawnSync(bashPath(), ['-n', scriptPath], { encoding: 'utf8' });
  assert.strictEqual(syntax.status, 0, syntax.stderr || `${path.basename(scriptPath)} must pass bash -n`);
}

for (const token of [
  'CAPTAINFIN_DEPLOY_DETACHED',
  'nohup env',
  'logs/deploy-',
  'tail --pid=',
  '.deploy-production.lock',
  "trap '' HUP",
  'COMPOSE_PARALLEL_LIMIT',
  'prepare-production-env.js --write',
  '--user "$(id -u):$(id -g)"',
  'docker compose config',
  'docker compose build',
  'BACKUP_DIR=/backups/predeploy',
  'recovery-tools npm run db:backup',
  'docker compose run --rm --no-deps migrate',
  'docker compose up -d --no-deps app automation-worker activity-worker backup-worker',
  'npm run verify:deployment'
]) {
  assert(deployScript.includes(token), `deployment script must contain ${token}`);
}
assert(gitignore.includes('.env.pre-runtime-roles-*.bak'), 'generated env safety copies must be ignored by git');
assert(gitignore.includes('.env.before-*'), 'older env safety copies must be ignored by git');
assert(gitignore.includes('.deploy-production.lock'), 'deployment lock state must be ignored by git');
assert(gitignore.includes('.runtime/'), 'watchdog runtime counters/locks must never be committed');
assert(dockerignore.includes('.env.*'), 'all derivative .env secret files must stay out of Docker build context');
assert(/COMPOSE_PARALLEL_LIMIT:-1/.test(deployScript), 'production builds must default to one concurrent Compose operation');
assert(/another CAPTAiNFiN production deployment is already running/.test(deployScript), 'deployment must refuse overlapping production runs');
for (const name of ['captainfin','captainfin-automation','captainfin-activity','captainfin-backup','captainfin-postgres']) {
  assert(compose.includes(`container_name: ${name}`), `Compose runtime identity missing ${name}`);
}
assert(!/container_name:\s*steam-fusion/.test(compose), 'legacy steam-fusion container names must not remain in Compose');
assert(deployScript.includes('adopt_legacy_container captainfin steam-fusion')
  && deployScript.includes('adopt_legacy_container captainfin-postgres steam-fusion-postgres'),
  'deployment must adopt existing legacy containers before runtime recreation');
assert(composeRuntime.includes('docker compose ps --all --quiet "$service"'), 'runtime resolver must derive physical containers from Compose service identity');
for (const source of [deployScript, watchdog, recovery]) {
  assert(source.includes('scripts/lib/compose-runtime.sh'), 'runtime shell tooling must source the canonical Compose service resolver');
}
for (const [name,source] of [['watchdog',watchdog],['recovery',recovery]]) {
  assert(!/docker inspect[^\n]*(?:captainfin|steam-fusion)/.test(source), `${name} must not inspect branded physical container names`);
}
const deployWithoutAdoption=deployScript
  .replace(/adopt_legacy_container captainfin steam-fusion[\s\S]*?adopt_legacy_container captainfin-postgres steam-fusion-postgres/,'');
assert(!/docker inspect[^\n]*(?:captainfin|steam-fusion)/.test(deployWithoutAdoption), 'deployment health/rollback logic must resolve Compose services; branded names are allowed only in legacy adoption');
assert(deployScript.includes('compose_service_image_id app') && deployScript.includes('compose_service_health postgres'), 'deployment must resolve release images and PostgreSQL health by Compose service');
assert(watchdog.includes('compose_service_state app') && watchdog.includes('compose_service_health postgres'), 'watchdog must resolve app/PostgreSQL by Compose service');
assert(recovery.includes('wait_service_health "$service"') && recovery.includes('compose_service_health postgres'), 'recovery must resolve service health by Compose service');

assert(compose.includes('POSTGRES_DB: steamfusion')
  && compose.includes('POSTGRES_USER: steamfusion')
  && compose.includes('steamfusion_pgdata:/var/lib/postgresql/data')
  && compose.includes('SESSION_COOKIE_NAME: ${SESSION_COOKIE_NAME:-steamfusion.sid}'),
  'state-bearing legacy database/volume/cookie identities must remain frozen for upgrade compatibility');
assert(compose.includes('user: "${BACKUP_PUID:-1000}:${BACKUP_PGID:-1000}"'), 'backup and recovery containers must support the host backup owner identity');
assert((compose.match(/user: "\$\{BACKUP_PUID:-1000\}:\$\{BACKUP_PGID:-1000\}"/g) || []).length === 2, 'both backup-worker and recovery-tools must use the configured backup identity');
assert((compose.match(/\/tmp:size=2g,mode=1777/g) || []).length === 2, 'backup and recovery temporary mounts must remain writable by a non-image UID');
assert((compose.match(/STREMIO_JELLYFIN_TOKEN_KEY: \$\{STREMIO_JELLYFIN_TOKEN_KEY:-\}/g) || []).length === 2, 'app and automation-worker must receive the same managed Stremio token key');
assert((compose.match(/image: \$\{CAPTAINFIN_IMAGE:-captainfin:current\}/g) || []).length === 6, 'migrate/app/workers/recovery must share the canonical runtime image');
assert.strictEqual((compose.match(/pull_policy:\s*never/g) || []).length, 6, 'internal runtime services must never pull the local verified runtime tag from a registry');
assert.strictEqual((compose.match(/^\s+build:\s*\.\s*$/gm) || []).length, 1, 'only the app service may own the Docker build definition');
assert(deployScript.includes('export CAPTAINFIN_IMAGE="captainfin:${CAPTAINFIN_BUILD_SHA}"'), 'production deployment must derive the release image tag only from build SHA');
assert(deployScript.includes('docker compose build') && /docker compose build[\s\S]*?\n\s*app\b/.test(deployScript), 'deployment must build the shared application image once through app');
assert(deployScript.includes('for service in app automation-worker activity-worker backup-worker'), 'deployment must verify every long-running runtime service build identity');
assert(deployScript.includes('compose_service_env_value "$service" CAPTAINFIN_BUILD_SHA'), 'runtime build verification must read the image-provided build SHA');
assert(deployScript.indexOf('npm run verify:deployment') < deployScript.indexOf('docker image tag "$CAPTAINFIN_IMAGE" captainfin:current'), 'known-good current image alias must advance only after deployment verification succeeds');

assert(compose.includes('test: ["CMD", "node", "scripts/backup-healthcheck.js"]'), 'Docker backup health must prove worker liveness');
assert(verifyDeployment.includes("add('backup worker', backupWorkerAlive"), 'deployment verification must require backup worker liveness');
assert(verifyDeployment.includes('degraded_error=${backupWorker.last_error}'), 'deployment verification must surface backup operation errors diagnostically');
assert(!verifyDeployment.includes('&& (!backupWorker.last_error || backupWorker.next_run_at === null)'), 'backup operation errors must not block storefront deployment');
assert(backupWorker.includes('SELECT last_success_at,next_run_at,last_error FROM backup_worker_state'), 'backup due logic must inspect persisted failure state');
assert(backupWorker.indexOf('if (row.next_run_at)') < backupWorker.indexOf('if (row.last_error)'), 'a worker restart must honor persisted retry backoff after a failed backup');

// The revenue-facing app gets bounded database acquisition while background
// services have explicit CPU/memory ceilings. A maintenance runaway must lose
// capacity before it can starve the storefront or PostgreSQL host.
for (const token of [
  'stop_grace_period: ${APP_STOP_GRACE_PERIOD:-45s}',
  'DB_CONNECTION_TIMEOUT_MS: ${APP_DB_CONNECTION_TIMEOUT_MS:-3000}',
  'READINESS_TIMEOUT_MS: ${READINESS_TIMEOUT_MS:-6000}',
  'mem_limit: ${APP_MEMORY_LIMIT:-2g}',
  'mem_limit: ${AUTOMATION_MEMORY_LIMIT:-2g}',
  'mem_limit: ${ACTIVITY_MEMORY_LIMIT:-1g}',
  'mem_limit: ${BACKUP_MEMORY_LIMIT:-1g}',
  'cpus: ${BACKUP_CPU_LIMIT:-0.75}'
]) assert(compose.includes(token), `Compose resilience contract missing ${token}`);
assert(application.includes('pool: getPool()'), 'PostgreSQL session storage must share the bounded web pool instead of creating a second independent pool');
assert(!/new PgStore\(\{\s*conString:/s.test(application), 'session store must not bypass the bounded web database pool with its own conString pool');

// Host watchdog is deliberately outside the app container so it can recover an
// event-loop hang. It must be conservative with PostgreSQL and sacrifice
// non-critical backup work before customer availability.
assert(watchdog.includes('/health/live') && watchdog.includes('/health/ready'), 'watchdog must distinguish process liveness from dependency readiness');
assert(watchdog.includes("docker compose stop backup-worker"), 'unhealthy backup work must be isolated before the storefront');
assert(watchdog.includes("postgres_state") && watchdog.includes("postgres_health"), 'watchdog must inspect PostgreSQL state and health separately');
assert(watchdog.includes('refusing automatic DB restart'), 'running-but-unhealthy PostgreSQL must not be blindly restart-looped');
assert(watchdog.includes('WATCHDOG_RESTART_COOLDOWN_SECONDS'), 'watchdog recovery must have restart-storm protection');
assert(watchdog.includes('DEPLOY_LOCK="$ROOT/.deploy-production.lock"') && watchdog.includes('deployment_active()'), 'watchdog must honor the production deployment lock');
assert(watchdog.includes('automatic recovery is suspended for this watchdog pass'), 'watchdog must stand down while deployment owns the runtime');
assert(watchdogInstaller.includes('OnUnitActiveSec=30s'), 'systemd watchdog timer must run frequently enough for short recovery time');
assert(watchdogInstaller.includes('User=$RUN_AS_USER'), 'watchdog must run as the existing deployment account rather than root');

// Reverse-proxy identity is a security boundary for sessions, abuse limits and
// household enforcement. Never regress to trusting a hop count or raw
// forwarded-host header merely because the default Compose file is loopback-only.
assert(application.includes("const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal'"), 'application must default to explicit local/private proxy networks');
assert(application.includes("app.set('trust proxy', trustProxySetting())"), 'application must use the bounded trust-proxy policy');
assert(!application.includes("app.set('trust proxy', 1)"), 'application must not trust a blind proxy hop count');
assert(!application.includes('proxy: true'), 'session middleware must not independently trust every forwarded HTTPS header');
assert(!application.includes("req.get('x-forwarded-host')"), 'origin checks must not directly trust X-Forwarded-Host');
assert(application.includes("/^(true|\\d+)$/i.test(raw)"), 'unsafe blanket/hop-count TRUST_PROXY overrides must fail closed');

// Persistent rate-limit identities must remain pseudonymous; raw client IPs
// belong only in request memory and must never be stored in login_rate_limits.
assert(customerRateLimit.includes("crypto.createHmac('sha256'"), 'customer rate-limit bucket storage must use keyed hashing');
assert(customerRateLimit.includes('captainfin:customer-rate-limit:v1'), 'rate-limit hashing must remain domain separated');
assert(customerRateLimit.includes('const storageKey = bucketStorageKey(bucketKey)'), 'database writes must use the hashed rate-limit storage key');
assert(!customerRateLimit.includes('[String(bucketKey).slice(0,300), seconds]'), 'raw rate-limit bucket keys must not be persisted');

const order = [
  deployScript.indexOf('prepare-production-env.js --write'),
  deployScript.indexOf('docker compose config'),
  deployScript.indexOf('docker compose build'),
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
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(path.join(tempDir, backups[0])).mode & 0o777, 0o600, 'environment safety copy must be owner-readable/writable only');
  }

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

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  if (Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0) {
    assert(content.includes(`BACKUP_PUID=${uid}`), 'environment preparation must persist the deployment user UID for backup bind mounts');
    assert(content.includes(`BACKUP_PGID=${gid}`), 'environment preparation must persist the deployment user GID for backup bind mounts');
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
