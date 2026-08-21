'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const scripts = packageJson.scripts || {};
const scriptName = process.argv[2] || 'check:fast';
const timeoutArg = process.argv.find(arg => arg.startsWith('--timeout-ms='));
const timeoutMs = Math.max(1000, Number(timeoutArg?.split('=')[1] || process.env.CHECK_COMMAND_TIMEOUT_MS || 180000));

function expand(command, stack = []) {
  return String(command || '').split(/\s+&&\s+/).flatMap(part => {
    const match = part.match(/^npm run ([\w:-]+)$/);
    if (!match) return [part];
    const name = match[1];
    if (stack.includes(name)) throw new Error(`Recursive npm script reference: ${[...stack, name].join(' -> ')}`);
    if (!scripts[name]) throw new Error(`Unknown npm script: ${name}`);
    return expand(scripts[name], [...stack, name]);
  });
}

function terminate(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch (_) {}
  setTimeout(() => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (_) {}
  }, 5000).unref?.();
}

function run(command, index, total) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    console.log(`\n[${index}/${total}] ${command}`);
    const nodeCommand = command.match(/^node\s+(.+)$/);
    const child = nodeCommand ? spawn(process.execPath, nodeCommand[1].trim().split(/\s+/), {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: process.env
    }) : spawn(command, {
      shell: true,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: process.env
    });
    const timer = setTimeout(() => {
      terminate(child);
      const seconds = Math.round((Date.now() - started) / 1000);
      reject(new Error(`Timed out after ${seconds}s: ${command}`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`[${index}/${total}] completed in ${seconds}s`);
        resolve();
      } else {
        reject(new Error(`${command} failed with ${signal || `exit ${code}`} after ${seconds}s`));
      }
    });
  });
}

async function main() {
  if (!scripts[scriptName]) throw new Error(`Unknown npm script: ${scriptName}`);
  const commands = expand(scripts[scriptName], [scriptName]);
  for (let i = 0; i < commands.length; i += 1) await run(commands[i], i + 1, commands.length);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
