'use strict';

const { query } = require('../db');

function isAdminSession(req) {
    return Boolean(req.session?.authUserId && req.session?.authRole === 'admin');
}

async function ownerStatus(userId) {
    const result = await query(`
        SELECT role,active,COALESCE(is_owner,FALSE) AS is_owner
        FROM app_users
        WHERE id=$1
        LIMIT 1
    `, [userId]);
    const user = result.rows[0] || null;
    return Boolean(user && user.role === 'admin' && user.active && user.is_owner);
}

async function requireOwner(req,res,next) {
    if (!isAdminSession(req)) {
        return res.redirect('/login?session=expired');
    }
    try {
        if (await ownerStatus(req.session.authUserId)) return next();
        return res.status(403).send('Owner access is required for this administrative action.');
    } catch (error) {
        console.error('Owner authorization check failed:', error.message);
        return res.status(503).send('Owner authorization could not be verified safely.');
    }
}

// Support administrators retain customer/ticket/operational work, while the
// highest-impact platform configuration and credential surfaces stay owner-only.
const OWNER_ONLY_PATHS = [
    /^\/settings(?:\/|$)/,
    /^\/setup(?:\/|$)/,
    /^\/system(?:\/|$)/,
    /^\/operations(?:\/|$)/,
    /^\/backups(?:\/|$)/,
    /^\/configuration(?:\/|$)/,
    /^\/payment(?:s|-settings)?(?:\/|$)/,
    /^\/notifications\/preferences(?:\/|$)/,
    /^\/email(?:\/|$)/,
    /^\/provider-mappings(?:\/|$)/,
    /^\/data-export(?:\/|$)/
];

function isOwnerOnlyPath(path) {
    const clean = String(path || '').split('?')[0];
    return OWNER_ONLY_PATHS.some(pattern => pattern.test(clean));
}

async function ownerBoundary(req,res,next) {
    if (!isOwnerOnlyPath(req.path)) return next();
    return requireOwner(req,res,next);
}

module.exports = { isAdminSession, ownerStatus, requireOwner, ownerBoundary, isOwnerOnlyPath, OWNER_ONLY_PATHS };
