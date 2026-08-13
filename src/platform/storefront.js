'use strict';
const {query}=require('../db');
const customers=require('../customers');
async function settings(){const r=await query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key IN ('storefront','storefront_features')`);const map=Object.fromEntries(r.rows.map(x=>[x.setting_key,x.setting_value]));return{copy:map.storefront||{},features:Array.isArray(map.storefront_features)?map.storefront_features:[]}}
async function storefrontPage(req,res){res.setHeader('Cache-Control','public, max-age=60');try{const [plans,store]=await Promise.all([customers.listPublicPlans(),settings()]);return res.render('storefront/home',{siteName:process.env.SITE_NAME||'CAPTaINFiN',plans,store,registrationOpen:process.env.PUBLIC_REGISTRATION!=='false',loggedIn:Boolean(req.session?.customerId)})}catch(e){console.error('Storefront failed:',e.message);return res.status(500).send('Store temporarily unavailable')}}
module.exports={storefrontPage,settings};
