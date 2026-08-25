'use strict';

const express=require('express');
const docsRender=require('./docs-render');
const {SECTIONS}=require('./customer-docs-content');
const runtimeSettings=require('./runtime-settings');

const BASE_PATH='/account/docs';

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||BASE_PATH));}

function createCustomerDocsRouter(){
  const router=express.Router();
  router.use(BASE_PATH,requireCustomer);

  router.get(BASE_PATH,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const html=docsRender.renderDocsIndex({
        site:runtimeSettings.siteName(),
        basePath:BASE_PATH,
        backHref:'/account',
        backLabel:'Back to your account',
        brandLabel:'Guides',
        description:'How to get set up and manage your account: connecting Jellyfin and Stremio, your plan and billing, streaming limits, referrals, and security.',
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
        backHref:'/account',
        backLabel:'Back to your account',
        brandLabel:'Guides',
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

module.exports={createCustomerDocsRouter,BASE_PATH};
