'use strict';

const express=require('express');
const docsRender=require('./docs-render');
const guideSource=require('./docs-guide-source');
const runtimeSettings=require('./runtime-settings');
const customerNav=require('./customer-nav-html');

const BASE_PATH='/account/docs';
const SECTION_TITLES=['Customers','Help'];

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||BASE_PATH));}

function createCustomerDocsRouter(){
  const router=express.Router();
  router.use(BASE_PATH,requireCustomer);

  router.get(BASE_PATH,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const accountNavHtml=customerNav.nav('docs',await customerNav.optionsForCustomer(req.session.customerId));
      const html=docsRender.renderDocsIndex({
        site:runtimeSettings.siteName(),
        basePath:BASE_PATH,
        backHref:'/account',
        backLabel:'Back to your account',
        brandLabel:'Help',
        description:'Customer help for Jellyfin, Stremio, plans, billing, playback limits, account security and support.',
        sections:guideSource.loadSections(SECTION_TITLES),
        accountNavHtml
      });
      return res.send(html);
    }catch(error){return next(error);}
  });

  router.get(`${BASE_PATH}/:section/:page`,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const accountNavHtml=customerNav.nav('docs',await customerNav.optionsForCustomer(req.session.customerId));
      const html=docsRender.renderDocsPage({
        site:runtimeSettings.siteName(),
        basePath:BASE_PATH,
        backHref:'/account',
        backLabel:'Back to your account',
        brandLabel:'Help',
        sections:guideSource.loadSections(SECTION_TITLES),
        sectionSlug:req.params.section,
        pageSlug:req.params.page,
        accountNavHtml
      });
      if(!html)return res.status(404).send('Help page not found');
      return res.send(html);
    }catch(error){return next(error);}
  });

  return router;
}

module.exports={createCustomerDocsRouter,BASE_PATH};
