'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin') return next();
    return res.redirect('/login?session=expired');
}

function txt(value, max = 500) {
    return String(value || '').trim().slice(0, max);
}

function redirect(res, path, key, message) {
    return res.redirect(`${path}?${key}=${encodeURIComponent(message)}`);
}

function createAdminActionsRouter() {
    const router = express.Router();
    router.use('/admin', gate);
    router.use((req, res, next) => req.method === 'POST'
        ? (csrf.verify(req) ? next() : res.status(403).send('Invalid security token'))
        : next());

    router.post('/admin/requests/:id', async (req, res) => {
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
            return redirect(res, '/admin/requests', 'message', 'Request updated.');
        } catch (error) {
            return redirect(res, '/admin/requests', 'error', error.message);
        }
    });

    router.post('/admin/settings/storefront', async (req, res) => {
        try {
            const copy = {
                heroTitle: txt(req.body.heroTitle, 140),
                heroSubtitle: txt(req.body.heroSubtitle, 500),
                featureTitle: txt(req.body.featureTitle, 120),
                supportEmail: txt(req.body.supportEmail, 254),
                announcement: txt(req.body.announcement, 200)
            };
            const features = String(req.body.features || '')
                .split(/\r?\n/)
                .map(value => txt(value, 160))
                .filter(Boolean)
                .slice(0, 12);

            await transaction(async client => {
                await client.query(`
                    INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at)
                    VALUES('storefront',$1::jsonb,$2,NOW())
                    ON CONFLICT(setting_key) DO UPDATE
                    SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()
                `, [JSON.stringify(copy), req.session.authUserId]);
                await client.query(`
                    INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at)
                    VALUES('storefront_features',$1::jsonb,$2,NOW())
                    ON CONFLICT(setting_key) DO UPDATE
                    SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()
                `, [JSON.stringify(features), req.session.authUserId]);
                await client.query(`
                    INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                    VALUES($1,'admin.storefront.update','platform_settings','storefront','{}'::jsonb)
                `, [req.session.authUserId]);
            });
            return redirect(res, '/admin/settings', 'message', 'Storefront updated.');
        } catch (error) {
            return redirect(res, '/admin/settings', 'error', error.message);
        }
    });

    return router;
}

module.exports = { createAdminActionsRouter };
