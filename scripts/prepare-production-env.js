'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROLE_URLS = [
  ['APP_DATABASE_URL', 'steamfusion_app'],
  ['AUTOMATION_DATABASE_URL', 'steamfusion_automation'],
  ['ACTIVITY_DATABASE_URL', 'steamfusion_activity'],
  ['BACKUP_DATABASE_URL', 'steamfusion_backup'],
  ['BACKUP_VERIFY_DATABASE_URL', 'steamfusion_backup_verify']
];

function parseArgs(argv) {
  const options = { write: false, envFile: '.env' };
  for (const arg of argv) {
    if (arg === '--write') options.write = true;
    else if (arg === '--check') options.write = false;
    else if (arg.startsWith('--env-file=')) options.envFile = arg.slice('--env-file='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function unquote(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2 && ((trimmed[0] === '"' && trimmed.at(-1) === '"') || (trimmed[0] === "'" && trimmed.at(-1) === "'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getValue(content, key) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? unquote(match[1]) : '';
}

function setValue(content, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) return content.replace(re, line);
  return `${content.replace(/\s*$/, '')}\n${line}\n`;
}

function parsePgUrl(raw, envName) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error(`${envName} must be a valid PostgreSQL URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${envName} must use postgres:// or postgresql://`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) throw new Error(`${envName} must include host and database`);
  return url;
}

function decodedPassword(url) {
  return decodeURIComponent(url.password || '');
}

function endpointKey(url) {
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}/${decodeURIComponent(url.pathname.replace(/^\//, ''))}`;
}

function validateRuntimeUrl(raw, envName, expectedRole, ownerUrl) {
  const url = parsePgUrl(raw, envName);
  const username = decodeURIComponent(url.username || '');
  const password = decodedPassword(url);
  if (username !== expectedRole) throw new Error(`${envName} must authenticate as ${expectedRole}`);
  if (password.length < 24) throw new Error(`${envName} password must be at least 24 characters`);
  if (endpointKey(url) !== endpointKey(ownerUrl)) {
    throw new Error(`${envName} must point to the same PostgreSQL host/database as DATABASE_URL for the Compose deployment`);
  }
  return { url, password };
}

function generatedRuntimeUrl(ownerUrl, role) {
  const next = new URL(ownerUrl.toString());
  next.username = role;
  next.password = crypto.randomBytes(32).toString('hex');
  return next.toString();
}

function backupPath(envFile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${envFile}.pre-runtime-roles-${stamp}.bak`;
}

function writeAtomic(file, content, mode) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const envFile = path.resolve(options.envFile);
  if (!fs.existsSync(envFile)) throw new Error(`Environment file not found: ${envFile}`);

  const stat = fs.statSync(envFile);
  const original = fs.readFileSync(envFile, 'utf8');
  let content = original;
  const ownerRaw = getValue(content, 'DATABASE_URL');
  if (!ownerRaw) throw new Error('DATABASE_URL is required before runtime database URLs can be prepared');
  const ownerUrl = parsePgUrl(ownerRaw, 'DATABASE_URL');
  const ownerPassword = decodedPassword(ownerUrl);
  const seenPasswords = new Map();
  const generated = [];

  for (const [envName, role] of ROLE_URLS) {
    let raw = getValue(content, envName);
    if (!raw) {
      if (!options.write) throw new Error(`${envName} is missing; run this command with --write to generate it safely`);
      raw = generatedRuntimeUrl(ownerUrl, role);
      content = setValue(content, envName, raw);
      generated.push(envName);
    }

    const { password } = validateRuntimeUrl(raw, envName, role, ownerUrl);
    if (ownerPassword && password === ownerPassword) throw new Error(`${envName} must not reuse the owner DATABASE_URL password`);
    if (seenPasswords.has(password)) {
      throw new Error(`${envName} must not reuse the password from ${seenPasswords.get(password)}`);
    }
    seenPasswords.set(password, envName);
  }

  if (content !== original) {
    const backup = backupPath(envFile);
    fs.copyFileSync(envFile, backup);
    fs.chmodSync(backup, 0o600);
    writeAtomic(envFile, content, stat.mode & 0o777);
    console.log(`Updated ${envFile} with ${generated.length} isolated runtime database URL(s).`);
    console.log(`Previous environment file saved as ${backup}.`);
  } else {
    console.log(`Runtime database URLs are already valid in ${envFile}.`);
  }
  console.log('Runtime database credential preflight passed.');
}

try { main(); }
catch (error) {
  console.error(`Runtime environment preflight failed: ${error.message}`);
  process.exit(1);
}
