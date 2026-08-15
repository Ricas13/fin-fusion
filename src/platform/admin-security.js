'use strict';
const express=require('express');
const core=require('./admin-security-core');
function createAdminSecurityRouter(){const router=express.Router();router.use('/admin/security',(req,res,next)=>{if(req.session?.authRole==='reseller'&&req.session?.authUserId)return res.redirect('/reseller/security');return next()});router.use(core.createAdminSecurityRouter());return router}
module.exports={...core,createAdminSecurityRouter};
