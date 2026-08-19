'use strict';

// Compatibility facade for callers that still import the original dashboard
// view module. The active renderer lives in admin-dashboard-view-v2 while the
// reusable chart/formatting primitives have a dedicated owner.
const { renderDashboard } = require('./admin-dashboard-view-v2');
const utils = require('./admin-dashboard-view-utils');

module.exports = { renderDashboard, ...utils };
