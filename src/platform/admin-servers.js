'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const auth = require('../auth/service');
const registry = require('../jellyfin/registry');
const { encryptWithEnv } = require('../security/purpose-crypto');

const SERVER_CLASSES = new Set(['premium', 'free', 'custom']);
const SAFE_ERROR_PREFIXES = [
    'Slug must be ',
    'Enter a valid ',
    'Only http and https ',
    'URLs may not contain ',
    'URL hostname is required.',
    'JELLYFIN_ALLOWED_HOSTS must be configured ',
    'This Jellyfin hostname is not on the production allowlist.',
    'Jellyfin API key format is invalid.',
    'Number must be between ',
    'Invalid server class.',
    'Jellyfin rejected the server URL or API key.',
    'Jellyfin returned an unexpected response.',
    'Jellyfin validation timed out.',
    'Could not validate the Jellyfin server securely.',
    'Second-factor verification failed.',
    'Server name is required.',
    'Server not found.'
];

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
        throw new Error('Slug must be 3-60 lowercase letters, numbers or dashes.');
    }
    return slug;
}

function allowedHosts() {
    return new Set(String(process.env.JELLYFIN_ALLOWED_HOSTS || '')
        .split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
}

function normalizeUrl(value, { baseUrl = false } = {}) {
    const raw = cleanText(value, 500);
    if (!raw) return null;
    let parsed;
    try { parsed = new URL(raw); } catch (_) { throw new Error('Enter a valid http/https URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs are allowed.');
    if (parsed.username || parsed.password || parsed.hash) throw new Error('URLs may not contain credentials or fragments.');
    if (!parsed.hostname) throw new Error('URL hostname is required.');
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';

    if (baseUrl && process.env.NODE_ENV === 'production') {
        const hosts = allowedHosts();
        if (!hosts.size) throw new Error('JELLYFIN_ALLOWED_HOSTS must be configured before server URLs can be changed in production.');
        if (!hosts.has(parsed.hostname.toLowerCase())) throw new Error('This Jellyfin hostname is not on the production allowlist.');
    }
    return parsed.toString().replace(/\/$/, '');
}

function validateApiKey(value, required = true) {
    const key = String(value || '').trim();
    if (!key && !required) return null;
    if (key.length < 16 || key.length > 256 || /[\s\x00-\x1f\x7f]/.test(key)) {
        throw new Error('Jellyfin API key format is invalid.');
    }
    return key;
}

function boolField(value) {
    return value === 'on' || value === 'true' || value === true || value === '1';
}

function intField(value, { min = 0, max = 100000, nullable = false } = {}) {
    if ((value === '' || value == null) && nullable) return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Number must be between ${min} and ${max}.`);
    return number;
}

function safeAdminError(error) {
    if (error?.code === '23505') return 'A server with that name or slug already exists.';
    const message = String(error?.message || '');
    if (SAFE_ERROR_PREFIXES.some(prefix => message.startsWith(prefix))) return message;
    return 'The server change could not be completed safely.';
}

function parseServerForm(body, { apiKeyRequired = false } = {}) {
    const serverClass = cleanText(body.serverClass, 20).toLowerCase();
    if (!SERVER_CLASSES.has(serverClass)) throw new Error('Invalid server class.');
    return {
        name: cleanText(body.name, 100),
        slug: cleanSlug(body.slug),
        serverClass,
        baseUrl: normalizeUrl(body.baseUrl, { baseUrl: true }),
        publicUrl: normalizeUrl(body.publicUrl, { baseUrl: false }),
        location: cleanText(body.location, 100) || null,
        priority: intField(body.priority, { min: 0, max: 10000 }),
        maxUsers: intField(body.maxUsers, { min: 1, max: 100000, nullable: true }),
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
            headers: { 'X-Emby-Token': apiKey, Accept: 'application/json' }
        });
        if (!response.ok) throw new Error('Jellyfin rejected the server URL or API key.');
        const contentType = String(response.headers.get('content-type') || '');
        if (!contentType.includes('application/json')) throw new Error('Jellyfin returned an unexpected response.');
        return true;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('Jellyfin validation timed out.');
        if (error.message.startsWith('Jellyfin ')) throw error;
        throw new Error('Could not validate the Jellyfin server securely.');
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
                allowedHosts: Array.from(allowedHosts()),
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
            allowedHosts: Array.from(allowedHosts()),
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
                allowedHosts: Array.from(allowedHosts()),
                error: null
            });
        } catch (error) { return next(error); }
    });

    router.post('/admin/servers', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const secondFactorOk = await auth.verifySecondFactor(req.session.authUserId, req.body.code, req);
            if (!secondFactorOk) throw new Error('Second-factor verification failed.');
            const form = parseServerForm(req.body, { apiKeyRequired: true });
            if (!form.name) throw new Error('Server name is required.');
            const id = await createServer(req.session.authUserId, form);
            try { await registry.healthcheckServer(id); } catch (_) {}
            return res.redirect('/admin/servers?message=' + encodeURIComponent('Jellyfin server added and credentials validated.'));
        } catch (error) {
            console.warn('Admin server create rejected:', error.message);
            return res.status(400).render('admin/server-form', {
                siteName: process.env.SITE_NAME || 'CAPTaINFiN',
                server: null,
                csrfToken: csrf.token(req),
                allowedHosts: Array.from(allowedHosts()),
                error: safeAdminError(error)
            });
        }
    });

    router.post('/admin/servers/:serverId', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        let server = null;
        try {
            server = await serverDetail(req.params.serverId);
            if (!server) return res.status(404).send('Server not found');
            const secondFactorOk = await auth.verifySecondFactor(req.session.authUserId, req.body.code, req);
            if (!secondFactorOk) throw new Error('Second-factor verification failed.');
            const form = parseServerForm(req.body, { apiKeyRequired: false });
            if (!form.name) throw new Error('Server name is required.');
            await updateServer(req.session.authUserId, req.params.serverId, form);
            return res.redirect('/admin/servers?message=' + encodeURIComponent('Server configuration updated.'));
        } catch (error) {
            console.warn('Admin server update rejected:', error.message);
            return res.status(400).render('admin/server-form', {
                siteName: process.env.SITE_NAME || 'CAPTaINFiN',
                server: server || await serverDetail(req.params.serverId).catch(() => null),
                csrfToken: csrf.token(req),
                allowedHosts: Array.from(allowedHosts()),
                error: safeAdminError(error)
            });
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
    safeAdminError
};
