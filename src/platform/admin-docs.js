'use strict';

const express=require('express');
const docsRender=require('./docs-render');
const {SECTIONS}=require('./admin-docs-content');
const runtimeSettings=require('./runtime-settings');

const BASE_PATH='/admin/docs';

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}

function createAdminDocsRouter(){
  const router=express.Router();
  router.use(BASE_PATH,gate);

  router.get(BASE_PATH,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const html=docsRender.renderDocsIndex({
        site:runtimeSettings.siteName(),
        basePath:BASE_PATH,
        backHref:'/admin',
        backLabel:'Back to the dashboard',
        brandLabel:'Admin guide',
        description:'How to run day-to-day operations: customers, plans, servers, payments, bulk actions, security and backups.',
        sections:SECTIONS
      });
      return res.send(html);
    }catch(error){return next(error);}
  });

  router.get(`${BASE_PATH}/:section/:page`,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const html=docsRender.renderDocsPage({
        site:runtimeSettings.siteName(),
        basePath:BASE_PATH,
        backHref:'/admin',
        backLabel:'Back to the dashboard',
        brandLabel:'Admin guide',
        sections:SECTIONS,
        sectionSlug:req.params.section,
        pageSlug:req.params.page
      });
      if(!html)return res.status(404).send('Guide page not found');
      return res.send(html);
    }catch(error){return next(error);}
  });

  return router;
}

module.exports={createAdminDocsRouter,BASE_PATH};
