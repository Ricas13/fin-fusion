'use strict';

/**
 * Steam Fusion production security bootstrap.
 *
 * This file intentionally runs before the legacy app.js so existing routes/UI keep
 * working while unsafe defaults are removed. The legacy application can then be
 * refactored incrementally without exposing known credential/session issues.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const ROOT = __dirname;
const DATA_FILE = path.resolve(ROOT, 'db', 'data.json');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE.toLowerCase() === 'true'
    : IS_PRODUCTION;

function fail(message) {
    console.error(`\n❌ SECURITY STARTUP FAILURE: ${message}\n`);
    process.exit(1);
}

function looksUnsafeSecret(value) {
    const lowered = String(value || '').toLowerCase();
    return !value ||
        value.length < 32 ||
        lowered.includes('change-this') ||
        lowered.includes('change-me') ||
        lowered.includes('steam-fusion-secret') ||
        lowered === 'your-random-secret-key-change-this';
}

function validateEnvironment() {
    if (looksUnsafeSecret(SESSION_SECRET)) {
        fail('SESSION_SECRET must be a unique random value of at least 32 characters.');
    }

    // Jellyfin is deliberately NOT required at process startup. Modern server
    // configuration lives in PostgreSQL and is administered through the web UI;
    // a clean installation with zero Jellyfin servers is a supported state.

    if (ADMIN_PASSWORD && ADMIN_PASSWORD.length < 12) {
        fail('ADMIN_PASSWORD must be at least 12 characters when provided.');
    }

    if (ADMIN_PASSWORD === 'admin123') {
        fail('ADMIN_PASSWORD may not use the legacy admin123 password.');
    }
}

function emptyData() {
    return {
        admins: [],
        resellers: [],
        clients: [],
        messages: [],
        creditTransactions: [],
        contentRequests: []
    };
}

function normalizeData(data) {
    const normalized = data && typeof data === 'object' ? data : emptyData();
    for (const key of Object.keys(emptyData())) {
        if (!Array.isArray(normalized[key])) normalized[key] = [];
    }
    return normalized;
}

function stripClientPasswords(data) {
    const normalized = normalizeData(data);
    for (const client of normalized.clients) {
        if (client && typeof client === 'object') delete client.password;
    }
    return normalized;
}

function loadDataFile() {
    if (!fs.existsSync(DATA_FILE)) return emptyData();
    try {
        return normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    } catch (error) {
        fail(`Unable to parse ${DATA_FILE}: ${error.message}`);
    }
}

function atomicWriteData(data) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE);
    try { fs.chmodSync(DATA_FILE, 0o600); } catch (_) {}
}

function ensureSecureAdminAndMigrateData() {
    const data = loadDataFile();

    // If the legacy default account exists, never allow it to remain usable.
    const legacyAdmin = data.admins.find(a =>
        a && a.username === 'admin' && a.password && bcrypt.compareSync('admin123', a.password)
    );

    if (legacyAdmin) {
        if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
            fail('Legacy admin/admin123 detected. Set ADMIN_USERNAME and ADMIN_PASSWORD before starting.');
        }
        legacyAdmin.username = ADMIN_USERNAME;
        legacyAdmin.password = bcrypt.hashSync(ADMIN_PASSWORD, 12);
        legacyAdmin.passwordChangedAt = new Date().toISOString();
    }

    if (data.admins.length === 0) {
        if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
            fail('No admin account exists. Set ADMIN_USERNAME and ADMIN_PASSWORD for first bootstrap.');
        }
        data.admins.push({
            id: 1,
            username: ADMIN_USERNAME,
            password: bcrypt.hashSync(ADMIN_PASSWORD, 12),
            createdAt: new Date().toISOString(),
            passwordChangedAt: new Date().toISOString()
        });
    }

    // Legacy client credentials were stored in plaintext. Remove them at rest.
    stripClientPasswords(data);
    atomicWriteData(data);
}

function secureRandomFloat() {
    // 48 random bits, preserving Math.random's [0, 1) behaviour while replacing
    // the legacy non-cryptographic source used for generated credentials.
    return crypto.randomBytes(6).readUIntBE(0, 6) / 281474976710656;
}

function installCryptoRandomCompatibility() {
    Math.random = secureRandomFloat;
}

function installDataAtRestGuard() {
    const originalWriteFileSync = fs.writeFileSync.bind(fs);

    fs.writeFileSync = function guardedWriteFileSync(file, content, ...rest) {
        let resolved;
        try { resolved = path.resolve(String(file)); } catch (_) { resolved = ''; }

        if (resolved === DATA_FILE && typeof content === 'string') {
            try {
                const parsed = JSON.parse(content);
                stripClientPasswords(parsed);
                content = JSON.stringify(parsed, null, 2);
            } catch (_) {
                // Leave non-JSON writes untouched; app validation will catch a bad DB
                // on the next startup rather than corrupting the write here.
            }
        }
        return originalWriteFileSync(file, content, ...rest);
    };
}

function deepRedactPasswords(value, allowTopLevelPassword = false, depth = 0, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(item => deepRedactPasswords(item, false, depth + 1, seen));
    }

    const output = {};
    for (const [key, item] of Object.entries(value)) {
        const lowered = key.toLowerCase();
        if (lowered === 'password') {
            if (allowTopLevelPassword && depth === 0) output[key] = item;
            continue;
        }
        output[key] = deepRedactPasswords(item, false, depth + 1, seen);
    }
    return output;
}

function installExpressSecurity() {
    const expressPath = require.resolve('express');
    const realExpress = require(expressPath);

    // Sanitize JSON and template locals globally. Newly generated credentials are
    // allowed only in the immediate create/reset response so they can be copied once.
    const originalJson = realExpress.response.json;
    realExpress.response.json = function secureJson(body) {
        const allowOneTimePassword = [
            '/reseller/trial/create',
            '/reseller/client/reset-password',
            '/admin/reseller/reset-password'
        ].includes(this.req?.path);
        return originalJson.call(this, deepRedactPasswords(body, allowOneTimePassword));
    };

    const originalRender = realExpress.response.render;
    realExpress.response.render = function secureRender(view, options, callback) {
        if (options && typeof options === 'object') {
            options = deepRedactPasswords(options);
        }
        return originalRender.call(this, view, options, callback);
    };

    function securityMiddleware(req, res, next) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (IS_PRODUCTION) {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }

        // Reject browser cross-site state-changing requests. Requests without browser
        // origin metadata remain supported for trusted CLI/API administration.
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            if (req.get('sec-fetch-site') === 'cross-site') {
                return res.status(403).send('Cross-site request blocked');
            }
            const origin = req.get('origin');
            const forwardedHost = req.get('x-forwarded-host') || req.get('host');
            if (origin && forwardedHost) {
                try {
                    if (new URL(origin).host !== forwardedHost) {
                        return res.status(403).send('Origin mismatch');
                    }
                } catch (_) {
                    return res.status(403).send('Invalid origin');
                }
            }
        }

        next();
    }

    function wrappedExpress(...args) {
        const app = realExpress(...args);
        app.set('trust proxy', 1);
        app.disable('x-powered-by');
        app.use(securityMiddleware);
        return app;
    }

    Object.assign(wrappedExpress, realExpress);
    wrappedExpress.application = realExpress.application;
    wrappedExpress.request = realExpress.request;
    wrappedExpress.response = realExpress.response;
    require.cache[expressPath].exports = wrappedExpress;
}

function installSecureSessionDefaults() {
    const sessionPath = require.resolve('express-session');
    const realSession = require(sessionPath);

    function wrappedSession(options = {}) {
        const merged = {
            ...options,
            secret: SESSION_SECRET,
            name: process.env.SESSION_COOKIE_NAME || 'steamfusion.sid',
            proxy: true,
            resave: false,
            saveUninitialized: false,
            cookie: {
                maxAge: 24 * 60 * 60 * 1000,
                ...(options.cookie || {}),
                httpOnly: true,
                sameSite: 'lax',
                secure: COOKIE_SECURE
            }
        };
        return realSession(merged);
    }

    Object.assign(wrappedSession, realSession);
    require.cache[sessionPath].exports = wrappedSession;
}

function sanitizeTelegramMultipart(body) {
    if (typeof body !== 'string') return body;
    const marker = 'Content-Type: application/json\r\n\r\n';
    const start = body.indexOf(marker);
    if (start === -1) return body;
    const jsonStart = start + marker.length;
    const end = body.indexOf('\r\n--', jsonStart);
    if (end === -1) return body;

    try {
        const payload = JSON.parse(body.slice(jsonStart, end));
        const redacted = JSON.stringify(deepRedactPasswords(payload), null, 2);
        return body.slice(0, jsonStart) + redacted + body.slice(end);
    } catch (_) {
        return body;
    }
}

function installTelegramBackupRedaction() {
    const originalRequest = https.request.bind(https);
    https.request = function secureHttpsRequest(options, callback) {
        const request = originalRequest(options, callback);
        const host = typeof options === 'object' ? options.hostname || options.host : '';
        const targetPath = typeof options === 'object' ? options.path || '' : '';

        if (host === 'api.telegram.org' && String(targetPath).includes('/sendDocument')) {
            const originalWrite = request.write.bind(request);
            request.write = function secureWrite(chunk, ...rest) {
                if (Buffer.isBuffer(chunk)) {
                    const safe = sanitizeTelegramMultipart(chunk.toString('utf8'));
                    return originalWrite(Buffer.from(safe, 'utf8'), ...rest);
                }
                return originalWrite(sanitizeTelegramMultipart(chunk), ...rest);
            };
        }
        return request;
    };
}

function installSafeStartupLogging() {
    const originalLog = console.log.bind(console);
    console.log = (...args) => {
        if (args.some(arg => typeof arg === 'string' && arg.includes('Admin login: admin / admin123'))) {
            return originalLog('👤 Admin login: configured securely');
        }
        if (!process.env.JELLYFIN_URL && args.some(arg => typeof arg === 'string' && arg.startsWith('📺 Jellyfin:'))) {
            return originalLog('📺 Jellyfin: not configured — add a server from Administration → Servers');
        }
        return originalLog(...args);
    };
}

validateEnvironment();
ensureSecureAdminAndMigrateData();
installCryptoRandomCompatibility();
installDataAtRestGuard();
installExpressSecurity();
installSecureSessionDefaults();
installTelegramBackupRedaction();
installSafeStartupLogging();

require('./app');
