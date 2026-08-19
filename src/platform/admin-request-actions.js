'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin') return next();
    return res.redirect('/login?session=expired');
}

function txt(value, max = 500) {
    return String(value || '').trim().slice(0, max);
}

function redirect(res, key, message) {
    return res.redirect(`/admin/requests?${key}=${encodeURIComponent(message)}`);
}

function createAdminRequestActionsRouter() {
    const router = express.Router();
    router.use('/admin/requests', gate);

    router.post('/admin/requests/:id', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const status = txt(req.body.status, 20);
            if (!['pending', 'approved', 'declined', 'searching', 'available', 'failed'].includes(status)) {
                throw new Error('Invalid status.');
            }
            const response = txt(req.body.adminResponse, 1000);
            const updated = await query(`
                UPDATE content_requests
                SET status=$2,
                    admin_response=$3,
                    resolved_at=CASE WHEN $2 IN ('available','declined','failed') THEN NOW() ELSE NULL END
                WHERE id=$1
                RETURNING id
            `, [req.params.id, status, response]);
            if (!updated.rowCount) throw new Error('Request not found.');
            await query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'admin.request.update','content_request',$2,$3::jsonb)
            `, [req.session.authUserId, req.params.id, JSON.stringify({ status })]);
            return redirect(res, 'message', 'Request updated.');
        } catch (error) {
            return redirect(res, 'error', error.message);
        }
    });

    return router;
}

module.exports = { createAdminRequestActionsRouter };
