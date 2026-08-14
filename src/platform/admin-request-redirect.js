'use strict';

const express = require('express');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

function createAdminRequestRedirectRouter() {
    const router = express.Router();
    router.get('/admin/requests', gate, (_req, res) => res.redirect(302, '/admin/request-users'));
    return router;
}

module.exports = { createAdminRequestRedirectRouter };
