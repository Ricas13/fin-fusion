'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const bash = process.env.BASH_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'captainfin-recovery-test-'));
const shell = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const unix = value => value.replace(/\\/g, '/');

// Derive the mock fleet from the real Compose definition, not from the scripts
// under test: stale runtime names must fail lookup as they do on the host.
const containers = [...fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
  .matchAll(/^\s+container_name:\s*(\S+)/gm)].map(match => match[1]);
const mock = `
set -Eeuo pipefail
docker() {
  printf 'docker %s\\n' "$*" >> "$TRACE"
  if [[ "$1" == inspect ]]; then
    local name="\${@: -1}"
    case " $FLEET " in *" $name "*) ;; *) return 1 ;; esac
    if [[ "$3" == *Health* ]]; then printf healthy; else printf running; fi
  fi
  return 0
}
curl() {
  printf 'http %s\\n' "$*" >> "$TRACE"
  [[ "$SCENARIO" != wedged ]]
}
sleep() { :; }
flock() { return 0; }
export -f docker curl sleep flock
`;

function run(name, command, scenario = 'healthy') {
  const dir = path.join(temp, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backups'));
  fs.writeFileSync(path.join(dir, '.env'), '# isolated test, no credentials\n');
  fs.writeFileSync(path.join(dir, 'backups', 'fixture.pgdump.enc'), 'mock only');
  for (const file of ['recovery.sh', 'scripts/availability-watchdog.sh']) {
    fs.writeFileSync(path.join(dir, file), fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'));
  }
  const harness = path.join(dir, 'harness.sh');
  fs.writeFileSync(harness, `${mock}\ncd ${shell(unix(dir))}\n${command}\n`);
  const trace = path.join(dir, 'trace.log');
  const result = spawnSync(bash, [unix(harness)], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, TRACE: unix(trace), FLEET: containers.join(' '), SCENARIO: scenario,
      WATCHDOG_FAILURE_THRESHOLD: '1', WATCHDOG_POST_RESTART_WAIT_SECONDS: '0',
      CAPTAINFIN_WATCHDOG_STATE_DIR: unix(path.join(dir, 'state')),
      CAPTAINFIN_WATCHDOG_LOG_DIR: unix(path.join(dir, 'logs')),
      RESTORE_CONFIRM: 'RESTORE_CAPTAINFIN_DATABASE', CAPTAINFIN_RECOVERY_SKIP_SAFETY_BACKUP: '0' }
  });
  assert.strictEqual(result.status, 0, `${name}: ${result.error || result.stderr || result.stdout}`);
  return fs.readFileSync(trace, 'utf8');
}

try {
  const healthy = run('healthy', 'bash scripts/availability-watchdog.sh');
  assert(healthy.includes('/health/live') && healthy.includes('/health/ready'), 'healthy fleet must reach both HTTP probes');
  assert(!healthy.includes('docker compose'), 'healthy fleet must not be recreated or restarted');
  const wedged = run('wedged', 'bash scripts/availability-watchdog.sh', 'wedged');
  assert(wedged.includes('docker compose restart app'), 'wedged running app must reach recovery');
  const drill = run('drill', 'bash recovery.sh drill fixture.pgdump.enc');
  assert(drill.includes('node scripts/verify-backup.js'), 'healthy PostgreSQL must permit the restore drill');
  assert(!drill.includes('node scripts/restore-db.js'), 'drill must never restore production');
  const restore = run('restore', 'bash recovery.sh restore fixture.pgdump.enc');
  const safety = restore.indexOf('node scripts/backup-db.js');
  const mutation = restore.indexOf('node scripts/restore-db.js');
  assert(safety >= 0 && mutation > safety, 'restore must preserve a safety backup before replacing the database');
  assert(restore.includes('docker compose exec -T app npm run verify:deployment'), 'restore must pass service readiness and reach deployment verification');
  for (const name of containers.filter(name => !name.endsWith('-postgres'))) {
    assert(restore.split('\n').some(line => line.startsWith('docker inspect ') && line.endsWith(` ${name}`)), `restore must verify ${name}`);
  }
  console.log('runtime recovery behavior smoke: ok (healthy/wedged watchdog, drill, restore)');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
