'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const customers = require('../customers');
const { query } = require('../db');
const provisioning = require('../jellyfin/resilient-provisioning');
const requestUserSync = require('../integrations/request-user-sync');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const { createAdminActionsRouter } = require('./admin-actions');
const runtimeSettings = require('./runtime-settings');

const librarySelectionLimit = routeRateLimit.middleware({scope:'customer-library-selection',max:20,windowSeconds:300});
const requestPasswordSyncLimit = routeRateLimit.middleware({scope:'customer-request-password-sync',max:5,windowSeconds:900});
function requireCustomer(req, res, next) { if (req.session?.customerId && req.session?.customerUserId) return next(); return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl || '/account')); }

async function verifyPortalPassword(userId,password){
    if(typeof password!=='string'||!password)return false;
    const row=await query(`SELECT password_hash FROM app_users WHERE id=$1 AND role='customer' AND active=TRUE LIMIT 1`,[userId]);
    return Boolean(row.rowCount&&row.rows[0]?.password_hash&&await bcrypt.compare(password,row.rows[0].password_hash));
}

async function saveLibraries(req,res,accountId){
    if (!csrf.verify(req)) return res.redirect('/account?error=' + encodeURIComponent('Invalid or expired security token') + '#jellyfin-access');
    try {
        let target=String(accountId||req.body.accountId||'').trim();
        if(!target){
            const accounts=(await provisioning.normalAccounts(req.session.customerId)).filter(account=>!account.disabled&&account.server_enabled);
            if(accounts.length!==1)throw new Error('Choose the Jellyfin server whose libraries you want to update.');
            target=String(accounts[0].id);
        }
        const submitted=Array.isArray(req.body.library)?req.body.library:(req.body.library!==undefined?[req.body.library]:[]);
        const chosen=await provisioning.setLibrarySelectionForAccount(req.session.customerId,target,submitted);
        try {
            await provisioning.reconcileCustomer(req.session.customerId);
        } catch (reconcileError) {
            console.warn('Customer library selection saved but Jellyfin reconciliation failed:', {
                customerId:req.session.customerId,
                accountId:target,
                error:reconcileError.message
            });
            return res.redirect('/account?error=' + encodeURIComponent('Library selection was saved, but Jellyfin could not be updated right now. Use Retry setup or try again later.') + '#jellyfin-access');
        }
        return res.redirect('/account?message=' + encodeURIComponent(`Library visibility updated for this Jellyfin server (${chosen.length} selected).`) + '#jellyfin-access');
    } catch (error) {
        return res.redirect('/account?error=' + encodeURIComponent(error.message || 'Library visibility could not be updated safely.') + '#jellyfin-access');
    }
}

function createRuntimeLegacyRouter() {
    const router = express.Router();
    router.use(createAdminActionsRouter());

    router.post('/account/libraries', requireCustomer, librarySelectionLimit, (req,res)=>saveLibraries(req,res,null));
    router.post('/account/libraries/:accountId', requireCustomer, librarySelectionLimit, (req,res)=>saveLibraries(req,res,req.params.accountId));

    router.post('/account/requests/password', requireCustomer, async (req, res) => {
        if (!csrf.verify(req)) return res.redirect('/account?error=' + encodeURIComponent('Invalid or expired security token'));
        try {
            if (req.body.password !== req.body.confirmPassword) throw new Error('Request-site passwords do not match.');
            await requestUserSync.setCustomerPassword(req.session.customerId, req.body.password);
            return res.redirect('/account?message=' + encodeURIComponent('Request-site password updated.'));
        } catch (error) { return res.redirect('/account?error=' + encodeURIComponent(error.message || 'Request-site password could not be updated.')); }
    });

    router.post('/account/requests/password/sync', requireCustomer, requestPasswordSyncLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.redirect('/account?error=' + encodeURIComponent('Invalid or expired security token'));
        try {
            const portalPassword=String(req.body.currentPortalPassword||'');
            if(!(await verifyPortalPassword(req.session.customerUserId,portalPassword)))throw new Error('Current portal password was not accepted.');
            await requestUserSync.setCustomerPassword(req.session.customerId,portalPassword);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.request_password.sync_from_portal','customer',$2,'{"secretStored":false}'::jsonb)`,[req.session.customerUserId,req.session.customerId]).catch(()=>{});
            return res.redirect('/account?message='+encodeURIComponent('Your portal password is now synced to Seerr.'));
        } catch (error) {
            return res.redirect('/account?error='+encodeURIComponent(error.message||'Seerr password could not be synced.'));
        }
    });

    router.get('/api/platform/plans', async (_req, res, next) => { try { return res.json(await customers.listPublicPlans()); } catch (error) { return next(error); } });
    router.use((error, req, res, _next) => {
        console.error('Platform route error:', error);
        if (req.path.startsWith('/api/')) return res.status(500).json({ success: false, error: 'Internal server error' });
        if (req.path.startsWith('/account/')) return res.redirect('/account?error=' + encodeURIComponent('The request could not be completed. Please try again.'));
        return res.status(500).render('customer/message', { title:'Something went wrong', message:'The request could not be completed. Please try again.', siteName:runtimeSettings.siteName() });
    });
    return router;
}
module.exports = { createRuntimeLegacyRouter, requireCustomer, verifyPortalPassword };