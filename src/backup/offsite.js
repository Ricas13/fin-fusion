'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(value) {
  const raw = String(value || '/');
  return raw.split('/').map((segment, index) => {
    if (index === 0) return '';
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch (_) {}
    return awsEncode(decoded);
  }).join('/') || '/';
}

function normalizePrefix(value) {
  const cleaned = String(value || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return cleaned ? `${cleaned}/` : '';
}

function validateEndpoint(raw) {
  let endpoint;
  try { endpoint = new URL(String(raw || '')); }
  catch { throw new Error('BACKUP_S3_ENDPOINT must be a valid HTTPS URL'); }
  if (endpoint.protocol !== 'https:') throw new Error('BACKUP_S3_ENDPOINT must use HTTPS');
  if (endpoint.username || endpoint.password) throw new Error('BACKUP_S3_ENDPOINT must not contain credentials');
  if (endpoint.search || endpoint.hash) throw new Error('BACKUP_S3_ENDPOINT must not contain a query string or fragment');
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/';
  return endpoint;
}

function configFromEnv(env = process.env) {
  const enabled = bool(env.BACKUP_OFFSITE_ENABLED, false);
  const provider = String(env.BACKUP_OFFSITE_PROVIDER || 's3').trim().toLowerCase();
  const base = { enabled, provider };
  if (!enabled) return base;
  if (provider !== 's3') throw new Error(`Unsupported BACKUP_OFFSITE_PROVIDER: ${provider}`);

  const endpoint = validateEndpoint(env.BACKUP_S3_ENDPOINT);
  const bucket = String(env.BACKUP_S3_BUCKET || '').trim();
  const accessKeyId = String(env.BACKUP_S3_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.BACKUP_S3_SECRET_ACCESS_KEY || '').trim();
  const region = String(env.BACKUP_S3_REGION || 'us-east-1').trim();
  const sessionToken = String(env.BACKUP_S3_SESSION_TOKEN || '').trim();
  if (!bucket || bucket.includes('/')) throw new Error('BACKUP_S3_BUCKET is required and must be a bucket name');
  if (!accessKeyId) throw new Error('BACKUP_S3_ACCESS_KEY_ID is required when off-site backups are enabled');
  if (!secretAccessKey) throw new Error('BACKUP_S3_SECRET_ACCESS_KEY is required when off-site backups are enabled');
  if (!region) throw new Error('BACKUP_S3_REGION is required when off-site backups are enabled');

  return {
    enabled,
    provider,
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    prefix: normalizePrefix(env.BACKUP_S3_PREFIX || 'captainfin/'),
    forcePathStyle: bool(env.BACKUP_S3_FORCE_PATH_STYLE, true),
    maxAttempts: Math.max(1, Math.min(5, Number(env.BACKUP_S3_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS))
  };
}

function objectName(config, fileName) {
  const safeName = path.basename(String(fileName || ''));
  if (!safeName || safeName === '.' || safeName === '..') throw new Error('A backup file name is required for off-site copy');
  return `${config.prefix}${safeName}`;
}

function requestUrl(config, key = '', query = {}) {
  const url = new URL(config.endpoint.toString());
  const endpointPath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  if (config.forcePathStyle) {
    url.pathname = `${endpointPath}/${config.bucket}${key ? `/${key}` : ''}`;
  } else {
    url.hostname = `${config.bucket}.${url.hostname}`;
    url.pathname = `${endpointPath}${key ? `/${key}` : '/'}`;
  }
  url.search = '';
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.append(name, String(value));
  }
  return url;
}

function canonicalQuery(url) {
  const pairs = [];
  for (const [key, value] of url.searchParams.entries()) pairs.push([awsEncode(key), awsEncode(value)]);
  pairs.sort((a, b) => a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function signingHeaders(config, { method, url, payloadHash, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map(name => `${name}:${String(headers[name]).trim()}\n`).join('');
  const canonicalRequest = [
    method,
    canonicalPath(url.pathname),
    canonicalQuery(url),
    canonicalHeaders,
    signedNames.join(';'),
    payloadHash
  ].join('\n');
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, config.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
  return headers;
}

function safeRemoteError(statusCode, body = '') {
  const code = (String(body).match(/<Code>([^<]{1,120})<\/Code>/i) || [])[1];
  const error = new Error(code ? `S3 request failed (${statusCode}, ${code})` : `S3 request failed (${statusCode})`);
  error.statusCode = statusCode;
  error.remoteCode = code || null;
  return error;
}

function retryable(error) {
  const status = Number(error?.statusCode || 0);
  return !status || status === 408 || status === 429 || status >= 500;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function collectResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        reject(new Error('S3 response exceeded the safety limit'));
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

async function requestOnce(config, { method, key = '', query = {}, payloadHash = EMPTY_SHA256, bodyFile = null, responseFile = null }) {
  const url = requestUrl(config, key, query);
  const signed = signingHeaders(config, { method, url, payloadHash });
  const headers = { ...signed };
  if (bodyFile) headers['content-length'] = String(fs.statSync(bodyFile).size);

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, async res => {
      const status = Number(res.statusCode || 0);
      try {
        if (status < 200 || status >= 300) {
          const body = await collectResponse(res);
          reject(safeRemoteError(status, body));
          return;
        }
        if (responseFile) {
          const out = fs.createWriteStream(responseFile, { flags: 'wx', mode: 0o600 });
          try {
            await pipeline(res, out);
            resolve({ statusCode: status, body: '' });
          } catch (error) {
            try { fs.unlinkSync(responseFile); } catch (_) {}
            reject(error);
          }
          return;
        }
        const body = await collectResponse(res);
        resolve({ statusCode: status, body });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('S3 request timed out')));
    if (bodyFile) {
      pipeline(fs.createReadStream(bodyFile), req).catch(reject);
    } else {
      req.end();
    }
  });
}

async function withRetry(config, operation) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      if (attempt >= config.maxAttempts || !retryable(error)) break;
      await delay(Math.min(2000, 250 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

function xmlDecode(value) {
  return String(value || '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function parseKeys(xml) {
  return [...String(xml || '').matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map(match => xmlDecode(match[1]));
}

function createS3Destination(config = configFromEnv()) {
  if (!config.enabled) throw new Error('Off-site backups are not enabled');
  return {
    provider: 's3',
    objectName: fileName => objectName(config, fileName),
    async put(localPath, name, checksumSha256) {
      const stat = fs.lstatSync(localPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Off-site backup source must be a regular non-symlink file');
      const key = name || objectName(config, path.basename(localPath));
      const payloadHash = String(checksumSha256 || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error('A SHA-256 checksum is required before off-site upload');
      await withRetry(config, () => requestOnce(config, { method: 'PUT', key, payloadHash, bodyFile: localPath }));
      return { provider: 's3', objectName: key, sizeBytes: stat.size, checksumSha256: payloadHash };
    },
    async get(name, destinationPath) {
      if (!name) throw new Error('An off-site object name is required');
      await withRetry(config, () => requestOnce(config, { method: 'GET', key: name, responseFile: destinationPath }));
      return destinationPath;
    },
    async list({ limit = 100 } = {}) {
      const maxKeys = Math.max(1, Math.min(1000, Number(limit) || 100));
      const response = await withRetry(config, () => requestOnce(config, {
        method: 'GET',
        query: { 'list-type': 2, prefix: config.prefix, 'max-keys': maxKeys }
      }));
      return parseKeys(response.body);
    },
    async delete(name) {
      if (!name) throw new Error('An off-site object name is required');
      await withRetry(config, () => requestOnce(config, { method: 'DELETE', key: name }));
      return true;
    },
    async health() {
      await withRetry(config, () => requestOnce(config, {
        method: 'GET',
        query: { 'list-type': 2, prefix: config.prefix, 'max-keys': 1 }
      }));
      return { ok: true, provider: 's3' };
    }
  };
}

module.exports = {
  EMPTY_SHA256,
  awsEncode,
  canonicalPath,
  configFromEnv,
  createS3Destination,
  normalizePrefix,
  objectName,
  parseKeys,
  requestUrl,
  signingHeaders,
  validateEndpoint
};
