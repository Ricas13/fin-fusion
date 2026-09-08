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

function createAdminDiscordIdentityGuardRouter() {
    const router = express.Router();
    router.post('/admin/users/:customerId/profile', applyCanonicalDiscordIdentity);
    router.post('/admin/users/:customerId/manage/account', applyCanonicalDiscordIdentity);
    return router;
}

module.exports = {
    canonicalDiscordIdentity,
    applyCanonicalDiscordIdentity,
    createAdminDiscordIdentityGuardRouter
};
