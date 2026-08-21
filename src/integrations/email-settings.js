'use strict';

const { query } = require('../db');
const { encryptWithEnv, decryptWithEnv } = require('../security/purpose-crypto');
const smtp = require('./smtp-client');

const SECRET_ENV = 'DATA_ENCRYPTION_KEY';
const SECRET_PREFIX = 'smtp1';
let cache = null;

function bool(value) { return value === true || value === 'true' || value === '1' || value === 'on'; }
function email(value, required = false) {
    const text = String(value || '').trim().toLowerCase();
    if (!text && !required) return '';
    if (!text || !text.includes('@') || /[\r\n<>]/.test(text) || text.length > 254) throw new Error('Enter a valid email address.');
    return text;
}
function host(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 255 || /[\s/?#@]/.test(text)) throw new Error('Enter a valid SMTP hostname.');
    return text;
}
function port(value) {
    const number = Number.parseInt(String(value || ''), 10);
    if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('SMTP port must be between 1 and 65535.');
    return number;
}
function secureMode(value) {
    const mode = String(value || '').toLowerCase();
    if (!['tls','starttls','plain'].includes(mode)) throw new Error('Invalid SMTP security mode.');
    return mode;
}
function assertSafeAuthentication(mode, username, password) {
    if (mode === 'plain' && (String(username || '').trim() || password)) {
        throw new Error('SMTP authentication requires STARTTLS or TLS. Plain SMTP may only be used without credentials.');
    }
}

function environmentConfig() {
    const raw = String(process.env.SMTP_URL || '').trim();
    if (!raw) return { source: 'environment', enabled: false, configured: false };
    try {
        const url = new URL(raw);
        if (!['smtp:','smtps:'].includes(url.protocol)) throw new Error('SMTP_URL must use smtp:// or smtps://');
        const mode = url.protocol === 'smtps:' ? 'tls' : (url.searchParams.get('secure') === 'plain' ? 'plain' : 'starttls');
        const fromEmail = email(process.env.EMAIL_FROM || process.env.SMTP_FROM || url.searchParams.get('from') || '', false);
        const cfg = {
            source: 'environment',
            enabled: true,
            host: url.hostname,
            port: Number(url.port || (mode === 'tls' ? 465 : 587)),
            secureMode: mode,
            username: decodeURIComponent(url.username || ''),
            password: decodeURIComponent(url.password || ''),
            fromName: String(process.env.EMAIL_FROM_NAME || process.env.SITE_NAME || 'CAPTAiNFiN').trim(),
            fromEmail,
            replyTo: email(process.env.EMAIL_REPLY_TO || '', false)
        };
        assertSafeAuthentication(cfg.secureMode, cfg.username, cfg.password);
        cfg.configured = Boolean(cfg.host && cfg.port && cfg.fromEmail && (!cfg.username || cfg.password));
        return cfg;
    } catch (error) {
        return { source: 'environment', enabled: true, configured: false, error: error.message };
    }
}

async function rawRow() {
    const result = await query('SELECT * FROM email_gateway_settings WHERE id=1');
    return result.rows[0] || null;
}

function decryptPassword(value) {
    if (!value) return '';
    return decryptWithEnv(value, SECRET_ENV, SECRET_PREFIX);
}

async function load() {
    const row = await rawRow();
    if (!row) return environmentConfig();
    const cfg = {
        source: 'browser',
        enabled: Boolean(row.enabled),
        host: row.host || '',
        port: Number(row.port || 0),
        secureMode: row.secure_mode || 'starttls',
        username: row.username || '',
        password: decryptPassword(row.password_encrypted),
        passwordConfigured: Boolean(row.password_encrypted),
        fromName: row.from_name || '',
        fromEmail: row.from_email || '',
        replyTo: row.reply_to || '',
        updatedAt: row.updated_at
    };
    try {
        assertSafeAuthentication(cfg.secureMode, cfg.username, cfg.password);
        cfg.configured = cfg.enabled && Boolean(cfg.host && cfg.port && cfg.fromEmail && (!cfg.username || cfg.password));
    } catch (error) {
        cfg.configured = false;
        cfg.error = error.message;
    }
    return cfg;
}

async function get() {
    if (!cache) cache = await load();
    return { ...cache };
}
async function reload() { cache = await load(); return get(); }
async function status() {
    const cfg = await get();
    return {
        source: cfg.source,
        enabled: Boolean(cfg.enabled),
        configured: Boolean(cfg.configured),
        host: cfg.host || '',
        port: cfg.port || null,
        secureMode: cfg.secureMode || 'starttls',
        usernameConfigured: Boolean(cfg.username),
        passwordConfigured: Boolean(cfg.password),
        fromName: cfg.fromName || '',
        fromEmail: cfg.fromEmail || '',
        replyTo: cfg.replyTo || '',
        error: cfg.error || null,
        updatedAt: cfg.updatedAt || null
    };
}

async function save(input, actorUserId = null) {
    const current = await rawRow();
    const enabled = bool(input.enabled);
    const cfgHost = host(input.host);
    const cfgPort = port(input.port);
    const mode = secureMode(input.secureMode);
    const username = String(input.username || '').trim().slice(0, 300);
    let encryptedPassword = current?.password_encrypted || null;
    if (bool(input.clearPassword)) encryptedPassword = null;
    else if (String(input.password || '')) encryptedPassword = encryptWithEnv(String(input.password), SECRET_ENV, SECRET_PREFIX);
    const passwordPresent = Boolean(encryptedPassword);
    if (username && !passwordPresent) throw new Error('SMTP password is required when a username is configured.');
    assertSafeAuthentication(mode, username, passwordPresent);
    const fromEmail = email(input.fromEmail, true);
    const replyTo = email(input.replyTo, false) || null;
    const fromName = String(input.fromName || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 120) || 'CAPTAiNFiN';

    await query(`
        INSERT INTO email_gateway_settings(id,enabled,host,port,secure_mode,username,password_encrypted,from_name,from_email,reply_to,updated_by,updated_at)
        VALUES(1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT(id) DO UPDATE SET
            enabled=EXCLUDED.enabled,host=EXCLUDED.host,port=EXCLUDED.port,secure_mode=EXCLUDED.secure_mode,
            username=EXCLUDED.username,password_encrypted=EXCLUDED.password_encrypted,from_name=EXCLUDED.from_name,
            from_email=EXCLUDED.from_email,reply_to=EXCLUDED.reply_to,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [enabled,cfgHost,cfgPort,mode,username || null,encryptedPassword,fromName,fromEmail,replyTo,actorUserId]);
    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'email.gateway.update','email_gateway','primary',$2::jsonb)
    `, [actorUserId, JSON.stringify({ enabled, host: cfgHost, port: cfgPort, secureMode: mode, usernameConfigured: Boolean(username), passwordChanged: Boolean(input.password), passwordCleared: bool(input.clearPassword), fromEmail, replyTo })]);
    return reload();
}

async function useEnvironment(actorUserId = null) {
    await query('DELETE FROM email_gateway_settings WHERE id=1');
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'email.gateway.environment','email_gateway','primary','{}'::jsonb)`, [actorUserId]);
    return reload();
}

function transportConfig(cfg) {
    if (!cfg?.enabled || !cfg?.configured) throw new Error('Email delivery is disabled or not fully configured.');
    assertSafeAuthentication(cfg.secureMode, cfg.username, cfg.password);
    return {
        host: cfg.host,
        port: Number(cfg.port),
        secureMode: cfg.secureMode,
        username: cfg.username || '',
        password: cfg.password || '',
        timeoutMs: 10000,
        rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
        clientName: process.env.SMTP_CLIENT_NAME || 'captainfin.local'
    };
}

async function testConnection() {
    const cfg = await get();
    const started = Date.now();
    await smtp.verify(transportConfig(cfg));
    return { ok: true, latencyMs: Date.now() - started, host: cfg.host, port: cfg.port, secureMode: cfg.secureMode };
}

async function send(message) {
    const cfg = await get();
    await smtp.send(transportConfig(cfg), {
        fromName: cfg.fromName,
        fromEmail: cfg.fromEmail,
        replyTo: cfg.replyTo,
        ...message
    });
}

module.exports = { get, reload, status, save, useEnvironment, testConnection, send, transportConfig, environmentConfig, assertSafeAuthentication };
