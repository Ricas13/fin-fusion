'use strict';

// Express matches routes case-insensitively and without regard to a trailing
// slash, so every guard that decides on the request path must compare the same
// canonical form (lowercase, repeated slashes collapsed, trailing slash dropped).
// Comparing the raw path lets /Admin/Settings/x or /login/ slip past a guard
// while still reaching the real handler.
function canonicalPath(value) {
  const raw = String(value || '').split('?')[0].split('#')[0];
  const collapsed = raw.replace(/\/{2,}/g, '/').toLowerCase();
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') || '/' : collapsed;
}

module.exports = { canonicalPath };
