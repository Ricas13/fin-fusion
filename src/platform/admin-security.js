'use strict';
const express=require('express');
const core=require('./admin-security-core');
const stepUp=require('../auth/admin-step-up');
function createAdminSecurityRouter(){const router=express.Router();router.use(stepUp.createAdminStepUpRouter());router.use(core.createAdminSecurityRouter());router.use(stepUp.sensitiveMutationGuard);return router}
module.exports={...core,createAdminSecurityRouter};
