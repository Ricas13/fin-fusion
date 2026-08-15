'use strict';

const { query } = require('../db');
let cache=null,loadingPromise=null;
async function reload(){const result=await query("SELECT setting_value FROM platform_settings WHERE setting_key='platform'");cache=result.rows[0]?.setting_value&&typeof result.rows[0].setting_value==='object'?result.rows[0].setting_value:{};return cache}
async function ensureLoaded(){if(cache)return cache;if(!loadingPromise)loadingPromise=reload().finally(()=>{loadingPromise=null});return loadingPromise}
function siteName(){const stored=typeof cache?.siteName==='string'?cache.siteName.trim():'';return stored||String(process.env.SITE_NAME||'').trim()||'CAPTaINFiN'}
function publicRegistrationOpen(){const stored=cache?.publicRegistration;return typeof stored==='boolean'?stored:process.env.PUBLIC_REGISTRATION!=='false'}
function storefrontEnabled(){const stored=cache?.storefrontEnabled;if(typeof stored==='boolean')return stored;if(typeof process.env.STOREFRONT_ENABLED==='string')return process.env.STOREFRONT_ENABLED==='true';return true}
function requireEmailVerification(){const stored=cache?.requireEmailVerification;return typeof stored==='boolean'?stored:process.env.REQUIRE_EMAIL_VERIFICATION==='true'}
function requireAdminTwoFactor(){const stored=cache?.requireAdminTwoFactor;return typeof stored==='boolean'?stored:process.env.REQUIRE_ADMIN_2FA==='true'}
function requireResellerTwoFactor(){const stored=cache?.requireResellerTwoFactor;return typeof stored==='boolean'?stored:process.env.REQUIRE_RESELLER_2FA==='true'}
function entitlementJobIntervalMs(){const stored=Number(cache?.entitlementJobIntervalMs);return Number.isFinite(stored)&&stored>=30000?stored:Number(process.env.ENTITLEMENT_JOB_INTERVAL_MS||5*60*1000)}
function serverHealthIntervalMs(){const stored=Number(cache?.serverHealthIntervalMs);return Number.isFinite(stored)&&stored>=30000?stored:Number(process.env.SERVER_HEALTH_INTERVAL_MS||5*60*1000)}
function overseerrUrl(){return typeof cache?.overseerrUrl==='string'?cache.overseerrUrl.trim():''}
module.exports={reload,ensureLoaded,siteName,publicRegistrationOpen,storefrontEnabled,requireEmailVerification,requireAdminTwoFactor,requireResellerTwoFactor,entitlementJobIntervalMs,serverHealthIntervalMs,overseerrUrl};
