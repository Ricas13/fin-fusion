'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const csrf = require('../auth/csrf');
const {query}=require('../db');
const provisioning = require('../jellyfin/resilient-provisioning');
const requestUsers = require('../integrations/request-user-sync');
const routeRateLimit=require('../security/route-rate-limit');
const runtimeSettings=require('./runtime-settings');

const requestPasswordSyncLimit=routeRateLimit.middleware({scope:'customer-request-password-sync',max:5,windowSeconds:900});

function requireCustomer(req, res, next) {
    if (req.session?.customerId && req.session?.customerUserId) return next();
    return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl || '/account'));
}
function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function pending(customerId){const r=await query(`SELECT ja.id,ja.jellyfin_username,js.name server_name FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=$1 AND ja.password_setup_required=TRUE ORDER BY ja.is_primary DESC,ja.created_at`,[customerId]);return r.rows;}
async function setupPage(req,accounts,error=null){await runtimeSettings.ensureLoaded();return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Set Jellyfin password · ${esc(runtimeSettings.siteName())}</title><link rel="stylesheet" href="/css/customer-portal.css"><style>main{max-width:760px;margin:32px auto;padding:22px}.panel{padding:20px;margin:14px 0}.field{margin:12px 0}</style></head><body><main><h1>Choose your Jellyfin password</h1><p>Your streaming account was created with a one-time bootstrap credential that CAPTAiNFiN never displays or stores. Choose a password you know before opening Jellyfin.</p>${error?`<div class="notice error">${esc(error)}</div>`:''}${accounts.map(a=>`<section class="panel"><h2>${esc(a.jellyfin_username)}</h2><p>${esc(a.server_name)}</p><form method="post" action="/account/jellyfin/${esc(a.id)}/password"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="setup" value="1"><div class="field"><label>New Jellyfin password</label><input class="input" type="password" name="password" minlength="12" maxlength="200" autocomplete="new-password" required></div><div class="field"><label>Confirm password</label><input class="input" type="password" name="confirmPassword" minlength="12" maxlength="200" autocomplete="new-password" required></div><button class="button primary">Save Jellyfin password</button></form></section>`).join('')}</main></body></html>`;}
async function verifyPortalPassword(userId,password){
    if(typeof password!=='string'||!password)return false;
    const row=await query(`SELECT password_hash FROM app_users WHERE id=$1 AND role='customer' AND active=TRUE LIMIT 1`,[userId]);
    return Boolean(row.rowCount&&row.rows[0]?.password_hash&&await bcrypt.compare(password,row.rows[0].password_hash));
}

function createCustomerPasswordSyncRouter() {
    const router = express.Router();
    // Dashboard guard rather than a second GET /account owner. This router is
    // mounted before the canonical customer dashboard and only intercepts that
    // one request when a freshly-provisioned Jellyfin identity still needs a
    // customer-owned password.
    router.use('/account',(req,res,next)=>{
        if(req.method!=='GET'||req.path!=='/')return next();
        return requireCustomer(req,res,async()=>{try{const accounts=await pending(req.session.customerId);if(!accounts.length)return next();return res.redirect('/account/jellyfin/setup');}catch(error){return next(error)}});
    });
    router.get('/account/jellyfin/setup',requireCustomer,async(req,res,next)=>{try{const accounts=await pending(req.session.customerId);if(!accounts.length)return res.redirect('/account');return res.send(await setupPage(req,accounts,req.query.error||null));}catch(error){next(error)}});

    router.post('/account/jellyfin/:accountId/password', requireCustomer, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const target=req.body.setup==='1'?'/account/jellyfin/setup':'/account';
        const password = String(req.body.password || '');
        if(password.length<12||password.length>200)return res.redirect(target+'?error='+encodeURIComponent('Jellyfin password must be between 12 and 200 characters.'));
        if(req.body.confirmPassword!==undefined&&password!==String(req.body.confirmPassword||''))return res.redirect(target+'?error='+encodeURIComponent('Jellyfin passwords do not match.'));
        try {
            await provisioning.setJellyfinPassword(req.session.customerId, req.params.accountId, password);
            await query(`UPDATE jellyfin_accounts SET password_setup_required=FALSE,updated_at=NOW() WHERE id=$1 AND customer_id=$2`,[req.params.accountId,req.session.customerId]);
        } catch (error) {
            return res.redirect(target+'?error=' + encodeURIComponent(error.message || 'Jellyfin password could not be updated.'));
        }

        try {
            const config = await requestUsers.configuration();
            if (!config.configured) {
                return res.redirect('/account?message=' + encodeURIComponent('Jellyfin password updated.'));
            }
            const access = await requestUsers.requestAccessForCustomer(req.session.customerId);
            if (access?.access_suspended) {
                return res.redirect('/account?message=' + encodeURIComponent('Jellyfin password updated. Request access is currently suspended.'));
            }
            await requestUsers.setCustomerPassword(req.session.customerId, password);
            return res.redirect('/account?message=' + encodeURIComponent('Jellyfin and request-site passwords updated.'));
        } catch (error) {
            await requestUsers.markPasswordSyncFailure(req.session.customerId, error).catch(() => {});
            return res.redirect('/account?error=' + encodeURIComponent('Jellyfin password was updated, but the request-site password could not be synchronized. Use the request password control to retry.'));
        }
    });

    router.post('/account/jellyfin/:accountId/username', requireCustomer, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            await provisioning.renameJellyfinAccount(req.session.customerId, req.params.accountId, req.body.username, { actorUserId: req.session.customerUserId });
            return res.redirect('/account?message=' + encodeURIComponent('Jellyfin username updated. Your watched history and profile stay with the same Jellyfin user.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message || 'Jellyfin username could not be updated.'));
        }
    });

    router.post('/account/requests/password',requireCustomer,async(req,res)=>{
        if(!csrf.verify(req))return res.redirect('/account?error='+encodeURIComponent('Invalid or expired security token'));
        try{
            if(req.body.password!==req.body.confirmPassword)throw new Error('Request-site passwords do not match.');
            await requestUsers.setCustomerPassword(req.session.customerId,req.body.password);
            return res.redirect('/account?message='+encodeURIComponent('Request-site password updated.'));
        }catch(error){
            return res.redirect('/account?error='+encodeURIComponent(error.message||'Request-site password could not be updated.'));
        }
    });

    router.post('/account/requests/password/sync',requireCustomer,requestPasswordSyncLimit,async(req,res)=>{
        if(!csrf.verify(req))return res.redirect('/account?error='+encodeURIComponent('Invalid or expired security token'));
        try{
            const portalPassword=String(req.body.currentPortalPassword||'');
            if(!(await verifyPortalPassword(req.session.customerUserId,portalPassword)))throw new Error('Current portal password was not accepted.');
            await requestUsers.setCustomerPassword(req.session.customerId,portalPassword);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.request_password.sync_from_portal','customer',$2,'{"secretStored":false}'::jsonb)`,[req.session.customerUserId,req.session.customerId]).catch(()=>{});
            return res.redirect('/account?message='+encodeURIComponent('Your portal password is now synced to Seerr.'));
        }catch(error){
            return res.redirect('/account?error='+encodeURIComponent(error.message||'Seerr password could not be synced.'));
        }
    });

    return router;
}

module.exports = { createCustomerPasswordSyncRouter,pending,setupPage,verifyPortalPassword };
