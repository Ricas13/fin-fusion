'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const activation = require('../auth/account-activation');
const provisioning = require('../jellyfin/resilient-provisioning');
const adminGrants = require('../entitlements/admin-grants');
const runtimeSettings = require('./runtime-settings');
const operations = require('./operations-settings');
const { customerCreate } = require('./admin-catalog-shell');
const { layout, esc } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin') return next();
    return res.redirect('/login?session=expired');
}

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}

function txt(value, max = 500) {
    return String(value || '').trim().slice(0, max);
}

function redirect(res, key, message) {
    return res.redirect(`/admin/users/new?${key}=${encodeURIComponent(message)}`);
}

function resultPage(res, { siteName, title, body }) {
    return res.send(layout({ siteName, title, body, active: 'users' }));
}

async function createCustomer(req, res) {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');

    try {
        const username = txt(req.body.username, 40);
        const email = txt(req.body.email, 254).toLowerCase();
        const display = txt(req.body.displayName, 100) || username;
        const planCode = txt(req.body.planCode, 50);
        const provisioningMode = ['immediate', 'after_activation', 'portal_only'].includes(req.body.provisioningMode)
            ? req.body.provisioningMode
            : 'immediate';

        if (!/^[A-Za-z0-9._-]{3,40}$/.test(username) || !email.includes('@')) {
            throw new Error('Check the username and email.');
        }

        const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 12);
        const created = await transaction(async client => {
            const exists = await client.query(`
                SELECT 1 FROM app_users
                WHERE lower(username)=lower($1) OR lower(COALESCE(email,''))=lower($2)
            `, [username, email]);
            if (exists.rowCount) throw Object.assign(new Error('exists'), { code: '23505' });

            let plan = null;
            if (provisioningMode !== 'portal_only') {
                const found = await client.query(`
                    SELECT * FROM plans
                    WHERE code=$1
                      AND active=TRUE
                      AND archived_at IS NULL
                      AND (effective_from IS NULL OR effective_from<=NOW())
                      AND (effective_until IS NULL OR effective_until>NOW())
                      AND audience IN('direct','both')
                `, [planCode]);
                if (!found.rowCount) throw new Error('Choose an active direct-customer plan.');
                plan = found.rows[0];
            }

            const user = await client.query(`
                INSERT INTO app_users(email,username,password_hash,role,active,email_verified_at)
                VALUES($1,$2,$3,'customer',FALSE,NOW())
                RETURNING id
            `, [email, username, randomHash]);

            const customer = await client.query(`
                INSERT INTO customers(user_id,display_name,email,provisioning_mode)
                VALUES($1,$2,$3,$4)
                RETURNING id
            `, [user.rows[0].id, display, email, provisioningMode]);

            const subscription = plan
                ? await adminGrants.createAdminGrantTx(client, {
                    customerId: customer.rows[0].id,
                    plan,
                    actorUserId: req.session.authUserId
                })
                : null;

            await client.query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'admin.customer.create','customer',$2,$3::jsonb)
            `, [req.session.authUserId, customer.rows[0].id, JSON.stringify({
                planCode: plan?.code || null,
                serviceType: plan?.service_type || null,
                activationRequired: true,
                provisioningMode
            })]);

            return {
                userId: user.rows[0].id,
                customerId: customer.rows[0].id,
                subscriptionId: subscription?.id || null,
                serviceType: plan?.service_type || null
            };
        });

        let provisioned = provisioningMode !== 'immediate' ? null : true;
        if (provisioningMode === 'immediate') {
            try {
                await provisioning.reconcileCustomer(created.customerId);
            } catch (error) {
                provisioned = false;
                console.error('Initial customer provisioning failed:', error.message);
            }
        }

        const activationRecord = await activation.create({
            userId: created.userId,
            purpose: 'customer_activation',
            ttlDays: 7,
            createdBy: req.session.authUserId
        });
        await query('UPDATE customers SET activation_deadline=$2 WHERE id=$1', [created.customerId, activationRecord.expires_at]);

        await runtimeSettings.ensureLoaded();
        const siteName = runtimeSettings.siteName();
        const activationLink = await operations.absoluteUrl(req, `/activate/${encodeURIComponent(activationRecord.raw)}`);
        const baseUrl = new URL(activationLink).origin;
        const queued = await activation.queueEmail({
            activation: activationRecord,
            baseUrl,
            siteName
        }).catch(() => ({ queued: false }));

        const service = created.serviceType === 'stremio'
            ? 'Stremio'
            : created.serviceType === 'bundle' ? 'Jellyfin and Stremio' : 'Jellyfin';
        const status = provisioningMode === 'immediate'
            ? (provisioned
                ? `Customer entitlement created and ${service} prepared.`
                : `Customer created; ${service} setup needs attention.`)
            : provisioningMode === 'after_activation'
                ? `Customer entitlement created; ${service} will be prepared when activation completes.`
                : 'Portal-only customer created; no streaming entitlement was created.';

        return resultPage(res, {
            siteName,
            title: 'Customer created',
            body: `<div class="statusBanner ${provisioned === false ? 'warn' : ''}"><strong>${esc(status)}</strong></div><section class="section"><div class="formPanel"><p><strong>Username:</strong> ${esc(username)}</p><p><strong>Provisioning:</strong> ${esc(provisioningMode.replace(/_/g, ' '))}</p><p><strong>Activation:</strong> ${queued.queued ? 'Email queued. The link can also be copied below.' : 'Email could not be queued; copy the one-time link below.'}</p><div class="codeBox">${esc(activationLink)}</div><p class="muted">The customer chooses their own portal password. CAPTAiNFiN never displays it to the administrator.</p><div class="buttonRow"><a class="button" href="/admin/users/${esc(created.customerId)}">Open customer</a><a class="button secondary" href="/admin/users">Back to Customers</a></div></div></section>`
        });
    } catch (error) {
        console.error('Customer creation failed:', error.message);
        return redirect(
            res,
            'error',
            error.code === '23505' ? 'That username or email already exists.' : error.message
        );
    }
}

function createAdminCustomerCreateRouter() {
    const router = express.Router();
    router.use('/admin/users/new', gate, noStore);

    router.get('/admin/users/new', async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            return res.send(layout({
                siteName: runtimeSettings.siteName(),
                active: 'users',
                title: 'Add customer',
                subtitle: 'Choose activation and provisioning timing explicitly',
                body: await customerCreate(req),
                action: '<a class="button secondary" href="/admin/users">Back</a>'
            }));
        } catch (error) {
            return next(error);
        }
    });

    router.post('/admin/users/new', createCustomer);
    return router;
}

module.exports = { createAdminCustomerCreateRouter, createCustomer };
