'use strict';
const express=require('express');
const routes=require('./admin-security-routes');
const stepUp=require('../auth/admin-step-up');
function createAdminSecurityRouter(){const router=express.Router();router.use(stepUp.createAdminStepUpRouter());router.use(routes.createAdminSecurityRouter());router.use(stepUp.sensitiveMutationGuard);return router}
module.exports={...routes,createAdminSecurityRouter};
