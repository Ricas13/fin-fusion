'use strict';

const express=require('express');
const runtimeSettings=require('./runtime-settings');
const {customerCreate}=require('./admin-catalog-shell');
const {layout}=require('./admin-html');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin')return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function createAdminCustomerCreateRouter(){
  const r=express.Router();
  r.use('/admin/users/new',gate,noStore);
  r.get('/admin/users/new',async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      return res.send(layout({siteName:runtimeSettings.siteName(),active:'users',title:'Add customer',subtitle:'Choose activation and provisioning timing explicitly',body:await customerCreate(req),action:'<a class="button secondary" href="/admin/users">Back</a>'}));
    }catch(error){return next(error);}
  });
  return r;
}
module.exports={createAdminCustomerCreateRouter};
