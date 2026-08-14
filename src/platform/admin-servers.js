'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const registry = require('../jellyfin/registry');
const { encryptWithEnv } = require('../security/purpose-crypto');

const SERVER_CLASSES = new Set(['premium', 'free', 'custom']);
const SAFE_ERROR_PREFIXES = [
    'Slug must be ',
    'Enter a valid ',
    'Only http and https ',
    'URLs may not contain ',
    'URL hostname is required.',
    'Internal/base URL is required.',
    'Jellyfin API key is required.',
    'Jellyfin API key format is invalid.',
    'Priority must be between ',
    'Maximum users must be between ',
    'Invalid server class.',
    'Jellyfin returned HTTP ',
    'Jellyfin returned an unexpected response.',
    'Jellyfin validation timed out.',
    'Could not validate the Jellyfin server securely.',
    'Server name is required.',
    'Server not found.'
];

class FieldValidationError extends Error {
    constructor(field, message) {
        super(message);
        this.name = 'FieldValidationError';
        this.field = field;
    }
}

function invalidField(field, message) {
    return new FieldValidationError(field, message);
}

function requireNativeAdmin(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}

function cleanText(value, max = 120) {
    return String(value || '').trim().slice(0, max);
}

function cleanSlug(value) {
    const slug = cleanText(value, 60).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(slug)) {
        throw invalidField('slug', 'Slug must be 3-60 lowercase letters, numbers or dashes.');
    }
    return slug;
}

// Kept as a compatibility export for older templates. Jellyfin hostnames are
// now trusted when an authenticated administrator explicitly adds a server.
function allowedHosts() {
    return new Set();
}

function normalizeUrl(value, { baseUrl = false, field = null } = {}) {
    const fieldName = field || (baseUrl ? 'baseUrl' : 'publicUrl');
    const raw = cleanText(value, 500);
    if (!raw) {
        if (baseUrl) throw invalidField(fieldName, 'Internal/base URL is required.');
        return null;
    }

    let parsed;
    try { parsed = new URL(raw); }
    catch (_) { throw invalidField(fieldName, 'Enter a valid http/https URL.'); }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw invalidField(fieldName, 'Only http and https URLs are allowed.');
    }
    if (parsed.username || parsed.password || parsed.hash) {
        throw invalidField(fieldName, 'URLs may not contain credentials or fragments.');
    }
    if (!parsed.hostname) throw invalidField(fieldName, 'URL hostname is required.');

    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
}

function validateApiKey(value, required = true) {
    const key = String(value || '').trim();
    if (!key && required) throw invalidField('apiKey', 'Jellyfin API key is required.');
    if (!key && !required) return null;
    if (key.length < 16 || key.length > 256 || /[\s\x00-\x1f\x7f]/.test(key)) {
        throw invalidField('apiKey', 'Jellyfin API key format is invalid.');
    }
    return key;
}

function boolField(value) {
    return value === 'on' || value === 'true' || value === true || value === '1';
}

function intField(value, { min = 0, max = 100000, nullable = false, field = null, label = 'Number' } = {}) {
    if ((value === '' || value == null) && nullable) return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw invalidField(field, `${label} must be between ${min} and ${max}.`);
    }
    return number;
}

function safeAdminErrorInfo(error) {
    if (error instanceof FieldValidationError) {
        return { message: error.message, field: error.field || null };
    }
    if (error?.code === '23505') {
        const constraint = String(error.constraint || '').toLowerCase();
        const field = constraint.includes('slug') ? 'slug' : constraint.includes('name') ? 'name' : null;
        return { message: 'A server with that name or slug already exists.', field };
    }
    const message = String(error?.message || '');
    if (SAFE_ERROR_PREFIXES.some(prefix => message.startsWith(prefix))) return { message, field: error?.field || null };
    return { message: 'The server change could not be completed safely.', field: null };
}

function safeAdminError(error) {
    return safeAdminErrorInfo(error).message;
}

function formErrorRedirect(path, error) {
    const info = safeAdminErrorInfo(error);
    const params = new URLSearchParams({ error: info.message });
    if (info.field) params.set('field', info.field);
    return `${path}?${params.toString()}`;
}

function parseServerForm(body, { apiKeyRequired = false } = {}) {
    const name = cleanText(body.name, 100);
    if (!name) throw invalidField('name', 'Server name is required.');

    const serverClass = cleanText(body.serverClass, 20).toLowerCase();
    if (!SERVER_CLASSES.has(serverClass)) throw invalidField('serverClass', 'Invalid server class.');

    return {
        name,
        slug: cleanSlug(body.slug),
        serverClass,
        baseUrl: normalizeUrl(body.baseUrl, { baseUrl: true, field: 'baseUrl' }),
        publicUrl: normalizeUrl(body.publicUrl, { baseUrl: false, field: 'publicUrl' }),
        location: cleanText(body.location, 100) || null,
        priority: intField(body.priority, { min: 0, max: 10000, field: 'priority', label: 'Priority' }),
        maxUsers: intField(body.maxUsers, { min: 1, max: 100000, nullable: true, field: 'maxUsers', label: 'Maximum users' }),
        allowNewUsers: boolField(body.allowNewUsers),
        trialEnabled: boolField(body.trialEnabled),
        paidEnabled: boolField(body.paidEnabled),
        apiKey: validateApiKey(body.apiKey, apiKeyRequired)
    };
}

async function probeCredentials(baseUrl, apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${baseUrl}/System/Info`, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: registry.authHeaders(apiKey)
        });
        if (response.status === 401) {
            throw invalidField('apiKey', 'Jellyfin returned HTTP 401 — API key was not accepted.');
        }
        if (response.status === 403) {
            throw invalidField('baseUrl', 'Jellyfin returned HTTP 403 — request was blocked by the Jellyfin server or reverse proxy.');
        }
        if (!response.ok) {
            throw invalidField('baseUrl', `Jellyfin returned HTTP ${response.status} while validating the server.`);
        }
        const contentType = String(response.headers.get('content-type') || '');
        if (!contentType.includes('application/json')) {
            throw invalidField('baseUrl', 'Jellyfin returned an unexpected response.');
        }
        const info = await response.json();
        if (!info || typeof info !== 'object' || Array.isArray(info)) {
            throw invalidField('baseUrl', 'Jellyfin returned an unexpected response.');
        }
        return info;
    } catch (error) {
        if (error instanceof FieldValidationError) throw error;
        if (error.name === 'AbortError') throw invalidField('baseUrl', 'Jellyfin validation timed out.');
        if (error.message.startsWith('Jellyfin ')) throw error;
        throw invalidField('baseUrl', 'Could not validate the Jellyfin server securely.');
    } finally {
        clearTimeout(timer);
    }
}

async function serverList() {
    const result = await query(`
        SELECT js.id,js.name,js.slug,js.server_class,js.public_url,js.location,js.enabled,
               js.allow_new_users,js.trial_enabled,js.paid_enabled,js.priority,js.max_users,
               js.health_status,js.last_health_check,js.created_at,js.updated_at,
               COUNT(DISTINCT ja.id)::int AS assigned_users,
               COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams
        FROM jellyfin_servers js
        LEFT JOIN jellyfin_accounts ja ON ja.server_id=js.id
        LEFT JOIN active_playback_sessions aps ON aps.server_id=js.id
        GROUP BY js.id ORDER BY js.priority,js.name
    `);
    return result.rows;
}

async function serverDetail(serverId) {
    const result = await query(`
        SELECT id,name,slug,server_class,base_url,public_url,location,enabled,allow_new_users,
               trial_enabled,paid_enabled,priority,max_users,health_status,last_health_check,
               created_at,updated_at
        FROM jellyfin_servers WHERE id=$1
    `, [serverId]);
    return result.rows[0] || null;
}

async function persistHealthCheck(serverId, status) {
    const result = await query(`
        UPDATE jellyfin_servers
        SET health_status=$2,last_health_check=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1
        RETURNING last_health_check
    `, [serverId, status]);
    if (!result.rowCount) throw new Error('Server not found.');
    return result.rows[0].last_health_check;
}

async function createServer(actorUserId, form) {
    await probeCredentials(form.baseUrl, form.apiKey);
    return transaction(async client => {
        const result = await client.query(`
            INSERT INTO jellyfin_servers(
                name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,priority,max_users,
                location,allow_new_users,trial_enabled,paid_enabled,health_status,last_health_check
            ) VALUES($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$9,$10,$11,$12,'unknown',NULL)
            RETURNING id
        `, [
            form.name,form.slug,form.serverClass,form.baseUrl,form.publicUrl,
            encryptWithEnv(form.apiKey,'JELLYFIN_ENCRYPTION_KEY','jf1'),form.priority,form.maxUsers,
            form.location,form.allowNewUsers,form.trialEnabled,form.paidEnabled
        ]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.server.create','jellyfin_server',$2,$3::jsonb)
        `, [actorUserId,result.rows[0].id,JSON.stringify({ fields: ['name','slug','serverClass','baseUrl','publicUrl','priority','maxUsers','placement','apiKey'] })]);
        return result.rows[0].id;
    });
}

async function updateServer(actorUserId, serverId, form) {
    const current = await registry.getServerSecret(serverId);
    if (!current) throw new Error('Server not found.');
    const candidateKey = form.apiKey || current.apiKey;
    const connectivityChanged = form.baseUrl !== current.base_url || Boolean(form.apiKey);
    if (connectivityChanged) await probeCredentials(form.baseUrl, candidateKey);

    await transaction(async client => {
        const result = await client.query(`
            UPDATE jellyfin_servers SET
                name=$2,slug=$3,server_class=$4,base_url=$5,public_url=$6,location=$7,
                priority=$8,max_users=$9,allow_new_users=$10,trial_enabled=$11,paid_enabled=$12,
                api_key_encrypted=CASE WHEN $13::text IS NULL THEN api_key_encrypted ELSE $13 END,
                health_status=CASE WHEN base_url<>$5 OR $13::text IS NOT NULL THEN 'unknown' ELSE health_status END,
                updated_at=NOW()
            WHERE id=$1 RETURNING id
        `, [
            serverId,form.name,form.slug,form.serverClass,form.baseUrl,form.publicUrl,form.location,
            form.priority,form.maxUsers,form.allowNewUsers,form.trialEnabled,form.paidEnabled,
            form.apiKey ? encryptWithEnv(form.apiKey,'JELLYFIN_ENCRYPTION_KEY','jf1') : null
        ]);
        if (!result.rowCount) throw new Error('Server not found.');
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.server.update','jellyfin_server',$2,$3::jsonb)
        `, [actorUserId,serverId,JSON.stringify({ credentialRotated: Boolean(form.apiKey), connectivityChanged })]);
    });
}

function createAdminServersRouter() {
    const router = express.Router();
    router.use('/admin/servers', requireNativeAdmin, noStore);

    router.get('/admin/servers', async (req, res, next) => {
        try {
            return res.render('admin/servers', {
                siteName: process.env.SITE_NAME || 'CAPTaINFiN',
                servers: await serverList(),
                allowedHosts: [],
                message: req.query.message || null,
                error: req.query.error || null
            });
        } catch (error) { return next(error); }
    });

    router.get('/admin/servers/new', (req, res) => {
        return res.render('admin/server-form', {
            siteName: process.env.SITE_NAME || 'CAPTaINFiN',
            server: null,
            csrfToken: csrf.token(req),
            allowedHosts: [],
            error: null
        });
    });

    router.get('/admin/servers/:serverId/edit', async (req, res, next) => {
        try {
            const server = await serverDetail(req.params.serverId);
            if (!server) return res.status(404).send('Server not found');
            return res.render('admin/server-form', {
                siteName: process.env.SITE_NAME || 'CAPTaINFiN',
                server,
                csrfToken: csrf.token(req),
                allowedHosts: [],
                error: null
            });
        } catch (error) { return next(error); }
    });

    router.post('/admin/servers', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const form = parseServerForm(req.body, { apiKeyRequired: true });
            const id = await createServer(req.session.authUserId, form);
            try { await registry.healthcheckServer(id); } catch (_) {}
            return res.redirect('/admin/servers?message=' + encodeURIComponent('Jellyfin server added and credentials validated.'));
        } catch (error) {
            console.warn('Admin server create rejected:', error.message);
            return res.redirect(formErrorRedirect('/admin/servers/new', error));
        }
    });

    router.post('/admin/servers/:serverId/test', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const started = Date.now();
        try {
            const server = await serverDetail(req.params.serverId);
            if (!server) return res.status(404).send('Server not found');
            const secret = await registry.getServerSecret(req.params.serverId);
            if (!secret) return res.status(404).send('Server not found');
            const info = await probeCredentials(secret.base_url, secret.apiKey);
            const latencyMs = Date.now() - started;
            const serverName = cleanText(info.ServerName, 100) || server.name;
            const version = cleanText(info.Version, 40);
            const checkedAt = await persistHealthCheck(req.params.serverId, 'healthy');
            await query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'admin.server.connection_test','jellyfin_server',$2,$3::jsonb)
            `, [req.session.authUserId,req.params.serverId,JSON.stringify({ ok: true, latencyMs, version: version || null, checkedAt })]);
            const detail = `${serverName}${version ? ` · Jellyfin ${version}` : ''} · ${latencyMs} ms`;
            return res.redirect('/admin/servers?message=' + encodeURIComponent(`Connection successful — ${detail}.`));
        } catch (error) {
            await persistHealthCheck(req.params.serverId, 'offline').catch(() => {});
            console.warn('Admin server connection test failed:', error.message);
            return res.redirect('/admin/servers?error=' + encodeURIComponent(`Connection failed — ${safeAdminError(error)}`));
        }
    });

    router.post('/admin/servers/:serverId', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const server = await serverDetail(req.params.serverId);
            if (!server) return res.status(404).send('Server not found');
            const form = parseServerForm(req.body, { apiKeyRequired: false });
            await updateServer(req.session.authUserId, req.params.serverId, form);
            return res.redirect('/admin/servers?message=' + encodeURIComponent('Server configuration updated.'));
        } catch (error) {
            console.warn('Admin server update rejected:', error.message);
            const path = '/admin/servers/' + encodeURIComponent(req.params.serverId) + '/edit';
            return res.redirect(formErrorRedirect(path, error));
        }
    });

    router.post('/admin/servers/:serverId/health', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const server = await serverDetail(req.params.serverId);
            if (!server) return res.status(404).send('Server not found');
            const result = await registry.healthcheckServer(req.params.serverId);
            await query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'admin.server.healthcheck','jellyfin_server',$2,$3::jsonb)
            `, [req.session.authUserId,req.params.serverId,JSON.stringify({ ok: result.ok, latencyMs: result.latencyMs })]);
            const message = result.ok ? `Server health check passed (${result.latencyMs} ms).` : 'Server health check failed.';
            return res.redirect('/admin/servers?' + (result.ok ? 'message=' : 'error=') + encodeURIComponent(message));
        } catch (error) {
            return res.redirect('/admin/servers?error=' + encodeURIComponent('Server health check could not be completed.'));
        }
    });

    router.use('/admin/servers', (error, _req, res, _next) => {
        console.error('Admin servers route error:', error.message);
        return res.status(500).render('auth/message', {
            siteName: process.env.SITE_NAME || 'CAPTaINFiN',
            title: 'Servers unavailable',
            message: 'Server administration could not be loaded safely.',
            link: '/admin',
            linkText: 'Return to Administration'
        });
    });

    return router;
}

module.exports = {
    createAdminServersRouter,
    serverList,
    serverDetail,
    parseServerForm,
    normalizeUrl,
    allowedHosts,
    probeCredentials,
    safeAdminError,
    safeAdminErrorInfo,
    persistHealthCheck,
    FieldValidationError
};
