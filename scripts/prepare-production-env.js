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

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
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

function isExamplePlaceholder(value) {
  return /^replace-with-unique-[a-z0-9-]+-secret$/i.test(String(value || '').trim());
}

function endpointKey(url) {
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}/${decodeURIComponent(url.pathname.replace(/^\//, ''))}`;
}

function validateRuntimeUrl(raw, envName, expectedRole, ownerUrl) {
  const url = parsePgUrl(raw, envName);
  const username = decodeURIComponent(url.username || '');
  const password = decodedPassword(url);
  if (username !== expectedRole) throw new Error(`${envName} must authenticate as ${expectedRole}`);
  if (isExamplePlaceholder(password)) throw new Error(`${envName} still contains an .env.example placeholder; run bash install.sh for a fresh installation or replace it with a unique secret`);
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

function numericId(value, envName) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${envName} must be a numeric UID/GID`);
  return Number(raw);
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
  if (isExamplePlaceholder(ownerPassword) || isExamplePlaceholder(getValue(content, 'POSTGRES_PASSWORD'))) {
    throw new Error('PostgreSQL owner credentials still contain .env.example placeholders; run bash install.sh for a fresh installation or replace them with unique secrets');
  }
  const seenPasswords = new Map();
  const updates = [];

  for (const [envName, role] of ROLE_URLS) {
    let raw = getValue(content, envName);
    if (!raw) {
      if (!options.write) throw new Error(`${envName} is missing; run this command with --write to generate it safely`);
      raw = generatedRuntimeUrl(ownerUrl, role);
      content = setValue(content, envName, raw);
      updates.push(envName);
    }

    const { password } = validateRuntimeUrl(raw, envName, role, ownerUrl);
    if (ownerPassword && password === ownerPassword) throw new Error(`${envName} must not reuse the owner DATABASE_URL password`);
    if (seenPasswords.has(password)) {
      throw new Error(`${envName} must not reuse the password from ${seenPasswords.get(password)}`);
    }
    seenPasswords.set(password, envName);
  }

  if (truthy(getValue(content, 'STREMIO_EDGE_AUTH_ENABLED'))) {
    let secret = getValue(content, 'STREMIO_EDGE_AUTH_SECRET');
    if (!secret) {
      if (!options.write) throw new Error('STREMIO_EDGE_AUTH_SECRET is required when STREMIO_EDGE_AUTH_ENABLED=true; run this command with --write to generate it safely');
      secret = crypto.randomBytes(32).toString('hex');
      content = setValue(content, 'STREMIO_EDGE_AUTH_SECRET', secret);
      updates.push('STREMIO_EDGE_AUTH_SECRET');
    }
    if (secret.length < 32) throw new Error('STREMIO_EDGE_AUTH_SECRET must contain at least 32 characters');
    const ttlRaw = getValue(content, 'STREMIO_EDGE_GRANT_TTL_SECONDS');
    if (ttlRaw) {
      const ttl = Number(ttlRaw);
      if (!Number.isInteger(ttl) || ttl < 1800 || ttl > 43200) {
        throw new Error('STREMIO_EDGE_GRANT_TTL_SECONDS must be an integer between 1800 and 43200');
      }
    }
  }

  let backupUid = numericId(getValue(content, 'BACKUP_PUID'), 'BACKUP_PUID');
  let backupGid = numericId(getValue(content, 'BACKUP_PGID'), 'BACKUP_PGID');
  if (options.write && (backupUid === null || backupGid === null)) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const gid = typeof process.getgid === 'function' ? process.getgid() : null;
    if (Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0) {
      if (backupUid === null) {
        content = setValue(content, 'BACKUP_PUID', String(uid));
        backupUid = uid;
        updates.push('BACKUP_PUID');
      }
      if (backupGid === null) {
        content = setValue(content, 'BACKUP_PGID', String(gid));
        backupGid = gid;
        updates.push('BACKUP_PGID');
      }
    }
  }

  if (content !== original) {
    const backup = backupPath(envFile);
    fs.copyFileSync(envFile, backup);
    fs.chmodSync(backup, 0o600);
    writeAtomic(envFile, content, stat.mode & 0o777);
    console.log(`Updated ${envFile} with ${updates.length} deployment value(s): ${updates.join(', ')}.`);
    console.log(`Previous environment file saved as ${backup}.`);
  } else {
    console.log(`Runtime database URLs and deployment identity are already valid in ${envFile}.`);
  }
  if (backupUid === null || backupGid === null) {
    console.warn('BACKUP_PUID/BACKUP_PGID are not set; Compose will use the image default UID/GID 1000:1000.');
  } else {
    console.log(`Backup containers will run as UID:GID ${backupUid}:${backupGid}.`);
  }
  console.log('Runtime database credential preflight passed.');
}

try { main(); }
catch (error) {
  console.error(`Runtime environment preflight failed: ${error.message}`);
  process.exit(1);
}
