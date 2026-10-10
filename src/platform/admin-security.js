'use strict';
const express=require('express');
const routes=require('./admin-security-routes');
const stepUp=require('../auth/admin-step-up');
function createAdminSecurityRouter(){const router=express.Router();router.use(stepUp.createAdminStepUpRouter());
// The step-up guard must run before the security routes: POST /admin/security/2fa-policy is one of
// the guarded mutations, and mounting the guard after these routes meant it never ran for it.
router.use(stepUp.sensitiveMutationGuard);router.use(routes.createAdminSecurityRouter());return router}
module.exports={...routes,createAdminSecurityRouter};
