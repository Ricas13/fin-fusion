'use strict';

// These are architecture constraints, not presentation preferences. A wildcard
// owner mounted before a literal route can make the literal production route
// unreachable even while both handlers exist in source.
const CRITICAL_PRECEDENCE = Object.freeze([
  Object.freeze(['usersDashboard', 'impersonation']),
  Object.freeze(['usersDashboard', 'customer360']),
  Object.freeze(['settingsCommerce', 'originalSettings']),
  Object.freeze(['planAccess', 'plans']),
  Object.freeze(['impersonation', 'customer360']),
  Object.freeze(['lanePolicy', 'customer360'])
]);

function assertAdminRouteOrder(order) {
  if (!Array.isArray(order) || !order.length) throw new Error('Admin route order must be a non-empty array.');
  const positions = new Map();
  order.forEach((name, index) => {
    const key = String(name || '');
    if (!key) throw new Error(`Admin route entry ${index} has no owner name.`);
    if (positions.has(key)) throw new Error(`Admin route owner ${key} is mounted more than once.`);
    positions.set(key, index);
  });
  for (const [before, after] of CRITICAL_PRECEDENCE) {
    if (!positions.has(before) || !positions.has(after)) throw new Error(`Critical admin route owners ${before} and ${after} must both be declared.`);
    if (positions.get(before) >= positions.get(after)) throw new Error(`Admin route owner ${before} must be mounted before ${after}.`);
  }
  return true;
}

module.exports = { CRITICAL_PRECEDENCE, assertAdminRouteOrder };
