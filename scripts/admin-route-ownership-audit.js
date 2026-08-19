'use strict';

// Runtime composition audit: exact method/path duplicates are almost always a
// shadow implementation when every router is mounted at the application root.
// A route that mounts first wins, leaving later code/tests misleadingly alive.
//
// The bootstrap owns transport/security middleware only. Application route
// order belongs to src/application-route-composition.js, while the main admin
// group remains in src/platform/admin-route-composition.js.

const fs = require('fs');
const path = require('path');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'route-ownership-audit-session-secret-2026-long-value';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

function assertOrder(source, markers, label) {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    if (index < 0) throw new Error(`${label} is missing ${marker}`);
    if (index <= previous) throw new Error(`${label} order changed around ${marker}`);
    previous = index;
  }
}

function assertCompositionBoundary() {
  const root = path.join(__dirname, '..', 'src');
  const applicationSource = fs.readFileSync(path.join(root, 'application.js'), 'utf8');
  const routeComposition = fs.readFileSync(path.join(root, 'application-route-composition.js'), 'utf8');
  const adminComposition = fs.readFileSync(path.join(root, 'platform', 'admin-route-composition.js'), 'utf8');

  if (!applicationSource.includes("require('./application-route-composition')")) {
    throw new Error('application.js must delegate concrete route registration to application-route-composition.js');
  }
  if (!applicationSource.includes('mountApplicationRoutes(app);')) {
    throw new Error('application.js does not mount canonical application route composition');
  }

  const directAdminImports = applicationSource.match(/require\('\.\/platform\/admin-[^']+'\)/g) || [];
  const unexpectedAdminImports = directAdminImports.filter(value => value !== "require('./platform/admin-nav')");
  if (unexpectedAdminImports.length) {
    throw new Error(`application.js imported admin route modules directly: ${unexpectedAdminImports.join(', ')}`);
  }
  if (/require\('\.\/platform\/customer-[^']+'\)/.test(applicationSource)) {
    throw new Error('application.js imported customer route modules directly instead of the application route composition');
  }
  for (const forbidden of [
    "require('./auth/first-run-controller')",
    "require('./platform/storefront')",
    "require('./platform/branding')",
    "require('./platform/flexible-checkout')",
    "require('./platform/router')"
  ]) {
    if (applicationSource.includes(forbidden)) {
      throw new Error(`application.js bypasses application route composition: ${forbidden}`);
    }
  }

  if (!routeComposition.includes("require('./platform/admin-route-composition')")) {
    throw new Error('application route composition must delegate the main admin group to admin-route-composition.js');
  }

  assertOrder(routeComposition, [
    'app.use(createFirstRunRouter());',
    "app.get('/login'",
    "app.post('/login'",
    "app.get('/logout'",
    'app.use(controller.createAuthRouter());',
    'app.use(createAdminSecurityRouter());',
    "app.get('/',",
    'app.use(createBrandingRouter());',
    'app.use(createCustomerClaimRouter());',
    'app.use(createCustomerPasswordSyncRouter());',
    'app.use(createCustomerSubscriptionActionsRouter());',
    'app.use(createFlexibleCheckoutRouter());',
    'app.use(createAdminPreviewRouter());',
    "app.use('/invite'",
    "app.use('/admin/invitations'",
    'mountAdminRoutes(app);',
    'app.use(createRouter());'
  ], 'application route composition');

  const directAdminModuleImports = routeComposition.match(/require\('\.\/platform\/admin-[^']+'\)/g) || [];
  const allowedDirectImports = new Set([
    "require('./platform/admin-security')",
    "require('./platform/admin-preview')",
    "require('./platform/admin-route-composition')"
  ]);
  const unexpected = directAdminModuleImports.filter(value => !allowedDirectImports.has(value));
  if (unexpected.length) {
    throw new Error(`application route composition bypasses canonical admin route group: ${unexpected.join(', ')}`);
  }

  for (const requiredFactory of [
    'createAdminAttentionRouter',
    'createAdminPlansRouter',
    'createAdminServersRouter',
    'createAdminCustomer360Router',
    'createAdminUsersRouter'
  ]) {
    if (!adminComposition.includes(requiredFactory)) {
      throw new Error(`admin route composition is missing expected owner: ${requiredFactory}`);
    }
  }
}

function rowsForPath(routePath) {
  return Array.isArray(routePath) ? routePath : [routePath];
}

function collect(stack, out = [], trail = []) {
  for (const layer of stack || []) {
    if (layer.route) {
      for (const routePath of rowsForPath(layer.route.path)) {
        for (const [method, enabled] of Object.entries(layer.route.methods || {})) {
          if (enabled) {
            out.push({
              method: method.toUpperCase(),
              path: String(routePath),
              trail: [...trail, layer.name || '<route>'].join(' > ')
            });
          }
        }
      }
    }
    if (layer.handle?.stack) collect(layer.handle.stack, out, [...trail, layer.name || '<router>']);
  }
  return out;
}

function main() {
  assertCompositionBoundary();
  const { createApplication } = require('../src/application');
  const app = createApplication();
  const stack = app._router?.stack || app.router?.stack || [];
  const routes = collect(stack).filter(row => row.path.startsWith('/admin'));
  const byKey = new Map();
  for (const row of routes) {
    const key = `${row.method} ${row.path}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const duplicates = [...byKey.entries()].filter(([, owners]) => owners.length > 1);
  if (duplicates.length) {
    console.error(`admin route ownership: ${duplicates.length} duplicate method/path route(s) found`);
    for (const [key, owners] of duplicates) {
      console.error(`\n${key}`);
      owners.forEach((owner, index) => console.error(`  ${index + 1}. ${owner.trail}`));
    }
    process.exit(1);
  }
  console.log(`admin route ownership: ok (${routes.length} mounted admin method/path routes, no exact duplicates; application composition explicit)`);
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
