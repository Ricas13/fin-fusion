'use strict';

const { query, transaction } = require('../db');
const { encryptWithEnv, decryptWithEnv } = require('./purpose-crypto');

const KEY = 'public_abuse_protection_v1';
const SECRET_ENV = 'DATA_ENCRYPTION_KEY';
const PREFIX = 'turnstile1';
const CORE_AUTH_PATHS = new Set(['/login', '/account/login', '/account/register']);
const FORM_PATHS = new Set([...CORE_AUTH_PATHS, '/account/forgot-password']);
const ACTIONS = Object.freeze({
  '/login': 'staff_login',
  '/account/login': 'customer_login',
  '/account/register': 'customer_registration',
  '/account/forgot-password': 'customer_password_reset'
});
let cache = null;

function bool(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

function text(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

async function load() {
  const result = await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1', [KEY]);
  const value = result.rows[0]?.setting_value || {};
  let secret = '';
  if (value.turnstileSecretEncrypted) {
    try {
      secret = decryptWithEnv(value.turnstileSecretEncrypted, SECRET_ENV, PREFIX);
    } catch (error) {
      throw new Error(`Turnstile secret could not be decrypted: ${error.message}`);
    }
  }
  return {
    enabled: Boolean(value.turnstileEnabled),
    siteKey: text(value.turnstileSiteKey, 200),
    secret,
    secretConfigured: Boolean(secret),
    // Registration and both sign-in surfaces are mandatory whenever Turnstile
    // is globally enabled. Keep the legacy field readable for compatibility,
    // but never let an old false value weaken the current authentication gate.
    protectRegistration: true,
    protectPasswordReset: value.protectPasswordReset !== false
  };
}

async function get() {
  if (!cache) cache = await load();
  return { ...cache };
}

async function reload() {
  cache = await load();
  return get();
}

async function save(input, actorUserId = null) {
  await transaction(async client => {
    const existing = (
      await client.query(
        'SELECT setting_value FROM platform_settings WHERE setting_key=$1 FOR UPDATE',
        [KEY]
      )
    ).rows[0]?.setting_value || {};

    let encrypted = existing.turnstileSecretEncrypted || null;
    if (bool(input.clearTurnstileSecret)) encrypted = null;
    else if (text(input.turnstileSecret, 500)) encrypted = encryptWithEnv(text(input.turnstileSecret, 500), SECRET_ENV, PREFIX);

    const value = {
      turnstileEnabled: bool(input.turnstileEnabled),
      turnstileSiteKey: text(input.turnstileSiteKey, 200),
      turnstileSecretEncrypted: encrypted,
      protectRegistration: true,
      protectPasswordReset: input.protectPasswordReset !== undefined ? bool(input.protectPasswordReset) : true
    };
    if (value.turnstileEnabled && (!value.turnstileSiteKey || !value.turnstileSecretEncrypted)) {
      throw new Error('Turnstile site key and secret are required when protection is enabled.');
    }

    await client.query(
      `INSERT INTO platform_settings(setting_key,setting_value,updated_by)
       VALUES($1,$2::jsonb,$3)
       ON CONFLICT(setting_key) DO UPDATE
       SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [KEY, JSON.stringify(value), actorUserId]
    );
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.public_abuse_protection.update','platform_setting',$2,$3::jsonb)`,
      [actorUserId, KEY, JSON.stringify({
        enabled: value.turnstileEnabled,
        coreAuthenticationProtected: true,
        protectPasswordReset: value.protectPasswordReset,
        secretChanged: Boolean(text(input.turnstileSecret, 500)),
        secretCleared: bool(input.clearTurnstileSecret)
      })]
    );
  });
  return reload();
}

function shouldProtect(cfg, path) {
  if (!cfg?.enabled) return false;
  if (CORE_AUTH_PATHS.has(path)) return true;
  return path === '/account/forgot-password' && cfg.protectPasswordReset;
}

function actionForPath(path) {
  return ACTIONS[path] || null;
}

function allowTurnstileCsp(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function exposeTurnstile(res, cfg, path) {
  const protectedForm = shouldProtect(cfg, path);
  res.locals.turnstileEnabled = protectedForm;
  res.locals.turnstileSiteKey = cfg.siteKey || '';
  res.locals.turnstileAction = actionForPath(path) || '';
  if (protectedForm) allowTurnstileCsp(res);
  return protectedForm;
}

async function verifyToken(token, remoteIp, { expectedAction = null } = {}) {
  const cfg = await get();
  if (!cfg.enabled) return { success: true, disabled: true };
  if (!cfg.secret) throw new Error('Turnstile secret is not configured.');
  const form = new URLSearchParams({ secret: cfg.secret, response: String(token || '') });
  if (remoteIp) form.set('remoteip', String(remoteIp).slice(0, 100));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: controller.signal,
      redirect: 'error'
    });
    const body = await response.json().catch(() => ({ success: false, 'error-codes': ['invalid-response'] }));
    if (!response.ok) throw new Error(`Turnstile verification returned HTTP ${response.status}.`);
    if (body.success && expectedAction && body.action !== expectedAction) {
      return { ...body, success: false, 'error-codes': [...(body['error-codes'] || []), 'action-mismatch'] };
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Turnstile verification timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function verificationFailure(path) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Verification failed</title></head><body style="font-family:system-ui;background:#0b1220;color:#e5e7eb;display:grid;place-items:center;min-height:100vh"><main style="max-width:520px;padding:28px;background:#111827;border-radius:16px"><h1>Verification failed</h1><p>The anti-abuse verification was not accepted. Return to the form and try again.</p><p><a style="color:#7dd3fc" href="${path}">Return to form</a></p></main></body></html>`;
}

async function middleware(req, res, next) {
  try {
    const cfg = await get();
    if (req.method === 'GET' && FORM_PATHS.has(req.path)) {
      exposeTurnstile(res, cfg, req.path);
      return next();
    }

    if (req.method === 'POST' && shouldProtect(cfg, req.path)) {
      // A successful Turnstile token is single-use. If the downstream login
      // handler re-renders the form after bad credentials, that POST response
      // must already contain a fresh widget and the Cloudflare CSP allowances.
      // Otherwise the next submit has no token and fails verification.
      exposeTurnstile(res, cfg, req.path);
      const expectedAction = actionForPath(req.path);
      const result = await verifyToken(
        req.body?.['cf-turnstile-response'],
        req.ip || req.socket?.remoteAddress,
        { expectedAction }
      );
      if (!result.success) {
        await query(
          `INSERT INTO audit_log(action,entity_type,entity_id,metadata)
           VALUES('public.turnstile.reject','public_request',$1,$2::jsonb)`,
          [req.path, JSON.stringify({ action: expectedAction, errors: result['error-codes'] || [] })]
        ).catch(() => {});
        res.status(400).setHeader('Cache-Control', 'no-store');
        return res.send(verificationFailure(req.path));
      }
    }
    return next();
  } catch (error) {
    console.error('Public abuse protection failed:', error.message);
    return res.status(503).send('Verification is temporarily unavailable. Try again shortly.');
  }
}

module.exports = {
  KEY,
  CORE_AUTH_PATHS,
  FORM_PATHS,
  ACTIONS,
  get,
  reload,
  save,
  verifyToken,
  shouldProtect,
  actionForPath,
  allowTurnstileCsp,
  exposeTurnstile,
  middleware
};
