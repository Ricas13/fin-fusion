'use strict';
const express=require('express');
const core=require('./admin-security-core');
const stepUp=require('../auth/admin-step-up');
function createAdminSecurityRouter(){const router=express.Router();router.use('/admin/security',(req,res,next)=>{if(req.session?.authRole==='reseller'&&req.session?.authUserId)return res.redirect('/reseller/security');return next()});router.use(stepUp.createAdminStepUpRouter());router.use(core.createAdminSecurityRouter());router.use(stepUp.sensitiveMutationGuard);return router}
module.exports={...core,createAdminSecurityRouter};
