'use strict';

const express = require('express');
const { transaction } = require('../db');
const csrf = require('../auth/csrf');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin') return next();
    return res.redirect('/login?session=expired');
}

function txt(value, max = 500) {
    return String(value || '').trim().slice(0, max);
}

function redirect(res, key, message) {
    return res.redirect(`/admin/settings?${key}=${encodeURIComponent(message)}`);
}

function createAdminStorefrontSettingsActionsRouter() {
    const router = express.Router();
    router.use('/admin/settings/storefront', gate);

    router.post('/admin/settings/storefront', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
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
            return redirect(res, 'message', 'Storefront updated.');
        } catch (error) {
            return redirect(res, 'error', error.message);
        }
    });

    return router;
}

module.exports = { createAdminStorefrontSettingsActionsRouter };
