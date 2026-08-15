'use strict';
const express=require('express');
const runtimeSettings=require('./runtime-settings');
const csrf=require('../auth/csrf');
function safeNext(value){const next=String(value||'');return next.startsWith('/')&&!next.startsWith('//')?next:'/account'}
function createCustomerLoginRouter(){const r=express.Router();r.get('/account/login',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();return res.render('customer/login',{error:null,message:req.query.session==='expired'?'Your session expired. Sign in again.':null,next:safeNext(req.query.next),csrfToken:csrf.token(req),siteName:runtimeSettings.siteName()})}catch(e){next(e)}});return r}
module.exports={createCustomerLoginRouter,safeNext};
