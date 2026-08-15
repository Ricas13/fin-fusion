'use strict';

const express=require('express');

// Compatibility factory retained for imports from older deployments. The
// canonical monthly reseller administration now lives in admin-resellers.js.
// Returning an empty router avoids duplicate/shadowed route registrations.
function createAdminResellerSummaryRouter(){return express.Router();}
module.exports={createAdminResellerSummaryRouter};
