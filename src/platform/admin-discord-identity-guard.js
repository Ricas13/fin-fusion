'use strict';

const express = require('express');
const { query } = require('../db');

async function canonicalDiscordIdentity(customerId, queryFn = query) {
    const result = await queryFn(`
        SELECT discord_user_id, discord_handle
        FROM customer_communication_preferences
        WHERE customer_id=$1
        LIMIT 1
    `, [customerId]);
    return {
        userId: result.rows[0]?.discord_user_id || null,
        username: result.rows[0]?.discord_handle || null
    };
}

async function applyCanonicalDiscordIdentity(req, _res, next) {
    try {
        const identity = await canonicalDiscordIdentity(req.params.customerId);
        req.body = req.body || {};
        // The verified OAuth link is authoritative. Existing customer profile
        // columns remain a compatibility mirror only and may never override it.
        req.body.discordUserId = identity.userId || '';
        req.body.discordUsername = identity.username || '';
        next();
    } catch (error) {
        next(error);
    }
}

function isProtectedCustomerWrite(req) {
    if (req.method !== 'POST') return false;
    // Express strips the /admin/users/:customerId prefix while this middleware
    // is running. Keep the canonical route owners intact; this is only a
    // pre-write invariant guard, not a second route implementation.
    return req.path === '/profile' || req.path === '/manage/account';
}

function createAdminDiscordIdentityGuardRouter() {
    const router = express.Router();
    router.use('/admin/users/:customerId', (req, res, next) => {
        if (!isProtectedCustomerWrite(req)) return next();
        return applyCanonicalDiscordIdentity(req, res, next);
    });
    return router;
}

module.exports = {
    canonicalDiscordIdentity,
    applyCanonicalDiscordIdentity,
    isProtectedCustomerWrite,
    createAdminDiscordIdentityGuardRouter
};
