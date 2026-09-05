'use strict';

require('dotenv').config();

const path = require('path');
const { randomUUID } = require('crypto');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);

const { query, closePool } = require('./db');
const firstRun = require('./auth/first-run-setup');
const controller = require('./auth/staff-controller');
const { guardSession } = require('./auth/session-guard');
const runtimeSettings = require('./platform/runtime-settings');
const operationsSettings = require('./platform/operations-settings');
const adminNav = require('./platform/admin-nav');
const { mountAdminRoutes } = require('./platform/admin-route-composition');
const { consumeLoginAttempt, pruneLoginRateLimits } = require('./security/login-rate-limit');
const customerRateLimit = require('./security/customer-rate-limit');
const publicAbuseProtection = require('./security/public-abuse-protection');
const { requestMaintenanceGuard } = require('./security/maintenance-lock');

const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const PORT = Number(process.env.PORT || 3030);
const SESSION_SECRET = String(process.env.SESSION_SECRET || '');
const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';
const DEFAULT_SHUTDOWN_GRACE_MS = 30000;

function fail(message) {
  throw new Error(`Startup configuration error: ${message}`);
}

function validateEnvironment() {
  if (IS_PRODUCTION && !process.env.DATABASE_URL) {
    fail('DATABASE_URL is required in production.');
  }
  if (!SESSION_SECRET || SESSION_SECRET.length < 32 || /change[-_ ]?(me|this)|example|placeholder/i.test(SESSION_SECRET)) {
    fail('SESSION_SECRET must be a unique random value of at least 32 characters.');
  }
  if (process.env.ADMIN_PASSWORD && String(process.env.ADMIN_PASSWORD).length < 8) {
    fail('ADMIN_PASSWORD must be at least 8 characters when supplied.');
  }
  if (String(process.env.ADMIN_PASSWORD || '') === 'admin123') {
    fail('The legacy admin123 password is not permitted.');
  }
}

function trustProxySetting(value = process.env.TRUST_PROXY) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return DEFAULT_TRUST_PROXY;
  if (/^(false|0|none|off)$/i.test(raw)) return false;
  // Hop counts and blanket trust are unsafe when an application can be reached
  // through more than one path. Require explicit proxy networks instead.
  if (/^(true|\d+)$/i.test(raw)) {
    fail('TRUST_PROXY must list trusted proxy addresses/ranges (for example loopback, linklocal, uniquelocal), not true or a hop count.');
  }
  return raw;
}

function requestContext(req, res, next) {
  const requestId = randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  return next();
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com https://www.paypal.com https://www.sandbox.paypal.com https://plisio.net"
  );
  if (IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).send('Cross-site request blocked');
    }
    const origin = req.get('origin');
    // Host is the actual HTTP Host presented by the trusted reverse proxy.
    // Do not read X-Forwarded-Host directly because a direct client could
    // otherwise make this origin check trust an unverified header.
    const host = req.get('host');
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) {
          return res.status(403).send('Origin mismatch');
        }
      } catch (_) {
        return res.status(403).send('Invalid origin');
      }
    }
  }
  return next();
}

function sessionMiddleware() {
  const options = {
    secret: SESSION_SECRET,
    name: process.env.SESSION_COOKIE_NAME || 'steamfusion.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 86400000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : IS_PRODUCTION
    }
  };
  if (process.env.DATABASE_URL) {
    options.store = new PgStore({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: false,
      tableName: 'user_sessions',
      pruneSessionInterval: 900
    });
  }
  return session(options);
}

async function staffLoginRateLimit(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/login') return next();
  try {
    const result = await consumeLoginAttempt(req.ip || req.socket?.remoteAddress || 'unknown', {
      windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 900000),
      maxAttempts: Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS || 10),
      secret: SESSION_SECRET
    });
    res.setHeader('X-RateLimit-Limit', String(result.maxAttempts));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.maxAttempts - result.attemptCount)));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, result.retryAfterSeconds)));
      return res.status(429).send('Too many login attempts. Try again later.');
    }
    return next();
  } catch (error) {
    console.error('Persistent staff login limiter unavailable:', error.message);
    return IS_PRODUCTION ? res.status(503).send('Login temporarily unavailable. Try again shortly.') : next();
  }
}

async function customerAuthRateLimit(req, res, next) {
  if (req.method !== 'POST' || !['/account/login', '/account/forgot-password'].includes(req.path)) return next();
  const reset = req.path === '/account/forgot-password';
  try {
    const result = await customerRateLimit.consume(
      `${reset ? 'customer-reset' : 'customer-login'}:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
      { limit: reset ? 5 : 10, windowMs: 900000 }
    );
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))));
      return res.status(429).send(reset ? 'Too many password reset requests. Try again later.' : 'Too many login attempts. Try again later.');
    }
    return next();
  } catch (error) {
    console.error('Persistent customer auth limiter unavailable:', error.message);
    return IS_PRODUCTION ? res.status(503).send('Authentication temporarily unavailable.') : next();
  }
}

async function publicMutationRateLimit(req, res, next) {
  if (req.method !== 'POST') return next();
  const requestPath = req.path || '';
  const kind = requestPath === '/account/register'
    ? 'registration'
    : requestPath.startsWith('/activate/')
      ? 'activation'
      : requestPath.includes('/claim')
        ? 'claim'
        : null;
  if (!kind) return next();
  try {
    const ops = await operationsSettings.get();
    const limit = kind === 'registration' ? ops.registrationRateLimitPerHour : Math.max(10, ops.registrationRateLimitPerHour * 2);
    const result = await customerRateLimit.consume(`public-${kind}:${req.ip || req.socket?.remoteAddress || 'unknown'}`, {
      limit,
      windowMs: 3600000
    });
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))));
      return res.status(429).send('Too many requests from this address. Try again later.');
    }
    return next();
  } catch (error) {
    console.error('Public mutation limiter unavailable:', error.message);
    return IS_PRODUCTION ? res.status(503).send('This action is temporarily unavailable.') : next();
  }
}

async function loginSetupGate(req, res, next) {
  try {
    if (await firstRun.isSetupRequired()) return res.redirect('/setup');
    try {
      await runtimeSettings.ensureLoaded();
    } catch (settingsError) {
      // Login can still use runtime-setting fallbacks, but an unavailable settings
      // store must never disappear silently: it is an operator-visible degraded state.
      console.warn('Runtime settings refresh failed before staff login.', {
        requestId: req.requestId || null,
        error: settingsError.message
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function mountPlatform(app) {
  const { createHealthRouter } = require('./platform/health');
  const { createWebhookRouter } = require('./platform/webhooks');
  const { createStremioRuntimeRouter } = require('./stremio/runtime');
  const { createFirstRunRouter } = require('./auth/first-run-controller');
  const { createAdminSecurityRouter } = require('./platform/admin-security');
  const { storefrontPage } = require('./platform/storefront');
  const { createRouter } = require('./platform/router');
  const { createCustomerPasswordSyncRouter } = require('./platform/customer-password-sync');
  const { createCustomerSubscriptionActionsRouter } = require('./platform/customer-subscription-actions');
  const { createFlexibleCheckoutRouter } = require('./platform/flexible-checkout');
  const { createCustomerClaimRouter } = require('./platform/customer-claim');
  const { createBrandingRouter } = require('./platform/branding');
  const { createAdminPreviewRouter } = require('./platform/admin-preview');
  const { createImpersonationAuditRouter } = require('./platform/admin-impersonation');

  app.use(createHealthRouter());
  app.use(createWebhookRouter());
  app.use(createStremioRuntimeRouter());
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: IS_PRODUCTION ? '1h' : 0 }));
  app.use(requestMaintenanceGuard);
  app.use(sessionMiddleware());
  app.use(guardSession);
  app.use(staffLoginRateLimit);
  app.use(customerAuthRateLimit);
  app.use(publicMutationRateLimit);

  app.use(createFirstRunRouter());
  app.get('/login', publicAbuseProtection.middleware, loginSetupGate, controller.loginPage);
  app.post('/login', publicAbuseProtection.middleware, loginSetupGate, controller.loginSubmit);
  app.get('/logout', controller.logout);
  app.use(controller.createAuthRouter());
  app.use(createAdminSecurityRouter());

  app.get('/', async (req, res, next) => {
    try {
      if (await firstRun.isSetupRequired()) return res.redirect('/setup');
      return storefrontPage(req, res, next);
    } catch (error) {
      return next(error);
    }
  });

  // The impersonation audit/banner middleware must be mounted before every
  // /account router below: it has to see each customer mutation, and an
  // earlier-mounted account router that sends its own response would
  // otherwise stop the request from ever reaching a later-mounted audit pass.
  // This is only the catch-all audit/banner concern -- the impersonate/exit
  // routes and the Customer 360 button-injection middleware stay owned by
  // admin-route-composition.js, since the latter has to stay positioned
  // after more specific /admin/users/* routes (e.g. /admin/users/dashboard)
  // to avoid shadowing them with its /admin/users/:customerId wildcard.
  app.use(createImpersonationAuditRouter());
  app.use(createBrandingRouter());
  app.use(createCustomerClaimRouter());
  app.use(createCustomerPasswordSyncRouter());
  app.use(createCustomerSubscriptionActionsRouter());
  app.use(createFlexibleCheckoutRouter());
  app.use(createAdminPreviewRouter());

  app.use('/invite', (_req, res) => res.status(410).send('Invitation onboarding is no longer available.'));
  app.use('/admin/invitations', (_req, res) => res.redirect(
    302,
    '/admin/users?message=' + encodeURIComponent('Invitations are retired. Add or import customers instead.')
  ));

  mountAdminRoutes(app);
  app.use(createRouter());
}

function unexpectedErrorPage({ isAdmin, requestId }) {
  const backHref = isAdmin ? '/admin' : '/account';
  const backLabel = isAdmin ? 'Back to admin' : 'Back to your account';
  const ref = requestId ? `<p class="ref">Reference: <code>${requestId}</code></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Something went wrong</title><style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c1117;color:#edf2f7;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:440px;margin:24px;padding:28px;border:1px solid #29323d;border-radius:14px;background:#141a21;text-align:center}
    h1{margin:0 0 10px;font-size:20px}
    p{margin:0 0 8px;color:#8d99aa;font-size:14px;line-height:1.5}
    .ref{margin-top:16px;font-size:12px}
    .ref code{color:#c3cbd6}
    a.button{display:inline-block;margin-top:18px;padding:10px 18px;border-radius:8px;background:#123d4d;border:1px solid #22657b;color:#eafaff;text-decoration:none;font-size:13px;font-weight:700}
  </style></head><body><main><h1>Something went wrong on our end</h1><p>This wasn't caused by anything you did. Please try again in a moment — if it keeps happening, contact support and mention the reference below.</p>${ref}<a class="button" href="${backHref}">${backLabel}</a></main></body></html>`;
}

function createApplication() {
  validateEnvironment();
  const app = express();
  app.set('trust proxy', trustProxySetting());
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.adminNavGroups = adminNav.groups;
  app.locals.adminNavActiveKey = adminNav.activeKey;
  app.locals.adminNavGroupFor = adminNav.groupFor;
  app.locals.adminNavSidebarKey = adminNav.sidebarKey;
  app.use(requestContext);
  app.use(securityHeaders);
  mountPlatform(app);
  app.use((req, res) => res.status(404).send('Not found'));
  app.use((error, req, res, _next) => {
    const routeTemplate = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : null;
    const requestId = req.requestId || null;
    console.error('Request failed:', {
      requestId,
      method: req.method,
      route: routeTemplate,
      error: error.message
    });
    if (res.headersSent) return;
    const status = Number(error.status || error.statusCode || 500);
    const finalStatus = status >= 400 && status < 600 ? status : 500;
    res.status(finalStatus);
    if (finalStatus < 500) return res.send(error.message);
    if (req.accepts(['html', 'json']) !== 'html') return res.json({ error: 'Something went wrong on our end.', requestId });
    return res.send(unexpectedErrorPage({ isAdmin: req.path.startsWith('/admin'), requestId }));
  });
  return app;
}

async function startupSummary() {
  try {
    const servers = await query('SELECT COUNT(*)::int n FROM jellyfin_servers WHERE enabled=TRUE');
    console.log(
      Number(servers.rows[0]?.n || 0) > 0
        ? `Jellyfin: ${servers.rows[0].n} enabled server(s) configured`
        : 'Jellyfin: not configured'
    );
  } catch (error) {
    console.warn('Jellyfin startup summary unavailable:', error.message);
  }
}

function shutdownGraceMs(value = process.env.SHUTDOWN_GRACE_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHUTDOWN_GRACE_MS;
  return Math.max(1000, Math.min(120000, Math.floor(parsed)));
}

function createGracefulShutdown({
  server,
  prune = null,
  closeDatabase = closePool,
  exit = code => process.exit(code),
  timeoutMs = shutdownGraceMs(),
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (!server || typeof server.close !== 'function') throw new Error('HTTP server is required for graceful shutdown.');
  let shutdownPromise = null;
  return function shutdown(signal = 'SIGTERM') {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = new Promise(resolve => {
      let finished = false;
      let timer = null;
      const finish = async initialCode => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeoutFn(timer);
        let code = initialCode;
        try { await closeDatabase(); }
        catch (error) {
          code = 1;
          console.error('Database shutdown failed:', error.message);
        }
        exit(code);
        resolve(code);
      };

      if (prune) clearIntervalFn(prune);
      console.log(`CAPTAiNFiN received ${signal}; draining HTTP requests for up to ${timeoutMs}ms.`);
      timer = setTimeoutFn(() => {
        console.warn(`CAPTAÏNFiN graceful shutdown timed out after ${timeoutMs}ms; forcing remaining HTTP connections closed.`);
        try { server.closeAllConnections?.(); } catch (_) {}
        finish(1);
      }, timeoutMs);
      timer.unref?.();

      try {
        server.close(error => {
          if (error) console.error('HTTP shutdown failed:', error.message);
          finish(error ? 1 : 0);
        });
        // Idle keep-alive sockets are not in-flight work and should not consume
        // the deployment grace period. Active requests remain untouched.
        server.closeIdleConnections?.();
      } catch (error) {
        console.error('HTTP shutdown failed:', error.message);
        finish(1);
      }
    });
    return shutdownPromise;
  };
}

function start({ installSignalHandlers = require.main === module } = {}) {
  const app = createApplication();
  const server = app.listen(PORT, () => {
    console.log('CAPTAiNFiN running');
    console.log(`CAPTAiNFiN web application listening on http://127.0.0.1:${PORT}`);
    startupSummary().catch(error => console.warn('Jellyfin startup summary task failed:', error.message));
  });
  const prune = setInterval(
    () => Promise.all([pruneLoginRateLimits(), customerRateLimit.cleanup()])
      .catch(error => console.warn('Rate-limit cleanup failed:', error.message)),
    3600000
  );
  prune.unref?.();
  const shutdown = createGracefulShutdown({ server, prune });
  if (installSignalHandlers) {
    process.once('SIGTERM', () => { shutdown('SIGTERM').catch(error => console.error('SIGTERM shutdown failed:', error.message)); });
    process.once('SIGINT', () => { shutdown('SIGINT').catch(error => console.error('SIGINT shutdown failed:', error.message)); });
  }
  return { app, server, shutdown };
}

if (require.main === module) start();

module.exports = {
  createApplication,
  start,
  createGracefulShutdown,
  shutdownGraceMs,
  securityHeaders,
  validateEnvironment,
  startupSummary,
  trustProxySetting,
  DEFAULT_TRUST_PROXY,
  DEFAULT_SHUTDOWN_GRACE_MS
};
