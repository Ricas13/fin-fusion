'use strict';

// Runtime composition audit: exact method/path duplicates are almost always a
// shadow implementation when every router is mounted at the application root.
// A route that mounts first wins, leaving later code/tests misleadingly alive.
//
// This audit also keeps the application bootstrap from becoming a second admin
// router registry. Top-level admin route order belongs to
// src/platform/admin-route-composition.js.

const fs = require('fs');
const path = require('path');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'route-ownership-audit-session-secret-2026-long-value';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

function assertCompositionBoundary() {
  const applicationSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'application.js'), 'utf8');
  const compositionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'admin-route-composition.js'), 'utf8');
  const platformRouterSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'router.js'), 'utf8');

  if (!applicationSource.includes("require('./platform/admin-route-composition')")) {
    throw new Error('application.js must delegate top-level admin route composition to admin-route-composition.js');
  }
  if (!applicationSource.includes('mountAdminRoutes(app);')) {
    throw new Error('application.js does not mount the canonical admin route composition');
  }

  // admin-nav is application metadata; admin-security and admin-preview are
  // deliberately mounted before the main admin route group. The composition
  // module itself is the single boundary for the remaining top-level routers.
  const directAdminModuleImports = applicationSource.match(/require\('\.\/platform\/admin-[^']+'\)/g) || [];
  const allowedDirectImports = new Set([
    "require('./platform/admin-nav')",
    "require('./platform/admin-route-composition')",
    "require('./platform/admin-security')",
    "require('./platform/admin-preview')"
  ]);
  const unexpected = directAdminModuleImports.filter(value => !allowedDirectImports.has(value));
  if (unexpected.length) {
    throw new Error(`application.js bypasses canonical admin route composition: ${unexpected.join(', ')}`);
  }

  // Express route traversal can see ordinary child routers via layer.handle.stack.
  // A custom path-prefix middleware hides that child stack, which would let a
  // duplicate admin owner escape the audit entirely. Do not allow that pattern.
  if (/onlyPathPrefix\(\s*['"]\/admin/.test(platformRouterSource)) {
    throw new Error('platform router hides an admin child router behind opaque path-prefix middleware');
  }
  if (platformRouterSource.includes('createAdminNotificationPreferencesRouter')) {
    throw new Error('global admin notification preferences must be owned only by admin-route-composition.js');
  }

  for (const requiredFactory of [
    'createAdminAttentionRouter',
    'createAdminPlansRouter',
    'createAdminServersRouter',
    'createAdminCustomer360Router',
    'createAdminUsersRouter',
    'createAdminNotificationPreferencesRouter'
  ]) {
    if (!compositionSource.includes(requiredFactory)) {
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
  console.log(`admin route ownership: ok (${routes.length} mounted admin method/path routes, no exact duplicates)`);
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
