'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');

function hash(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }
function rawNonce() { return crypto.randomBytes(32).toString('base64url'); }

async function createIntent({ scope, customerId = null, resellerId = null, planId = null, tierId = null, provider, checkoutMode = 'subscription', ttlMinutes = 30 }) {
    if (!['customer','reseller'].includes(scope)) throw new Error('Invalid checkout scope.');
    if (!['stripe','paypal'].includes(provider)) throw new Error('Invalid checkout provider.');
    if (!['payment','subscription'].includes(checkoutMode)) throw new Error('Invalid checkout mode.');
    const nonce = rawNonce();
    const expires = new Date(Date.now() + Math.max(5, Math.min(60, Number(ttlMinutes) || 30)) * 60000);
    const row = await transaction(async client => {
        const ownerColumn = scope === 'customer' ? 'customer_id' : 'reseller_id';
        const ownerId = scope === 'customer' ? customerId : resellerId;
        if (!ownerId) throw new Error('Checkout owner is required.');
        await client.query(`UPDATE billing_checkout_intents SET state='expired',updated_at=NOW()
            WHERE ${ownerColumn}=$1 AND state='open' AND expires_at<=NOW()`, [ownerId]);
        const existing = await client.query(`SELECT id,provider,checkout_mode,expires_at
            FROM billing_checkout_intents WHERE ${ownerColumn}=$1 AND state='open' LIMIT 1 FOR UPDATE`, [ownerId]);
        if (existing.rowCount) throw new Error('A checkout is already in progress. Finish or cancel it before starting another one.');
        const created = await client.query(`INSERT INTO billing_checkout_intents(
            scope,customer_id,reseller_id,plan_id,tier_id,provider,checkout_mode,nonce_hash,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [scope, customerId, resellerId, planId, tierId, provider, checkoutMode, hash(nonce), expires]);
        return created.rows[0];
    });
    return { ...row, nonce };
}

async function attachProviderCheckout(intentId, providerCheckoutId) {
    const result = await query(`UPDATE billing_checkout_intents
        SET provider_checkout_id=$2,updated_at=NOW() WHERE id=$1 AND state='open' RETURNING *`,
    [intentId, String(providerCheckoutId || '').slice(0, 300)]);
    if (!result.rowCount) throw new Error('Checkout intent is no longer open.');
    return result.rows[0];
}

async function consume({ intentId, nonce, providerCheckoutId = null, state = 'completed' }) {
    if (!['completed','cancelled','failed'].includes(state)) throw new Error('Invalid checkout completion state.');
    return transaction(async client => {
        const result = await client.query('SELECT * FROM billing_checkout_intents WHERE id=$1 FOR UPDATE', [intentId]);
        if (!result.rowCount) throw new Error('Checkout intent not found.');
        const row = result.rows[0];
        if (row.state !== 'open' || new Date(row.expires_at) <= new Date()) throw new Error('Checkout intent has expired or was already used.');
        if (!nonce || hash(nonce) !== row.nonce_hash) throw new Error('Checkout state verification failed.');
        if (providerCheckoutId && row.provider_checkout_id && String(row.provider_checkout_id) !== String(providerCheckoutId)) {
            throw new Error('Provider checkout does not match the local checkout intent.');
        }
        const updated = await client.query(`UPDATE billing_checkout_intents
            SET state=$2,completed_at=CASE WHEN $2='completed' THEN NOW() ELSE completed_at END,updated_at=NOW()
            WHERE id=$1 RETURNING *`, [intentId, state]);
        return updated.rows[0];
    });
}

async function getOpenForOwner(scope, ownerId) {
    const column = scope === 'customer' ? 'customer_id' : 'reseller_id';
    const result = await query(`SELECT * FROM billing_checkout_intents
        WHERE ${column}=$1 AND state='open' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`, [ownerId]);
    return result.rows[0] || null;
}

module.exports = { createIntent, attachProviderCheckout, consume, getOpenForOwner, hash };
