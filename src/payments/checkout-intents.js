'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');

function hash(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }
function rawNonce() { return crypto.randomBytes(32).toString('base64url'); }
function safeSnapshot(value){if(!value||typeof value!=='object'||Array.isArray(value))return{};const json=JSON.stringify(value);if(Buffer.byteLength(json,'utf8')>32768)throw new Error('Checkout commercial snapshot is too large.');return value;}

async function createIntent({ scope, customerId = null, resellerId = null, planId = null, tierId = null, provider, checkoutMode = 'subscription', ttlMinutes = 30, commercialSnapshot = {} }) {
    if (!['customer','reseller'].includes(scope)) throw new Error('Invalid checkout scope.');
    if (!['stripe','paypal'].includes(provider)) throw new Error('Invalid checkout provider.');
    if (!['payment','subscription'].includes(checkoutMode)) throw new Error('Invalid checkout mode.');
    const nonce = rawNonce();
    const snapshot=safeSnapshot(commercialSnapshot);
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
            scope,customer_id,reseller_id,plan_id,tier_id,provider,checkout_mode,nonce_hash,expires_at,commercial_snapshot)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
        [scope, customerId, resellerId, planId, tierId, provider, checkoutMode, hash(nonce), expires, JSON.stringify(snapshot)]);
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

function verifyRow(row,{nonce,providerCheckoutId=null,scope=null,provider=null,ownerId=null}={}) {
    if (!row) throw new Error('Checkout intent not found.');
    if (row.state !== 'open' || new Date(row.expires_at) <= new Date()) throw new Error('Checkout intent has expired or was already used.');
    if (!nonce || hash(nonce) !== row.nonce_hash) throw new Error('Checkout state verification failed.');
    if (providerCheckoutId && row.provider_checkout_id && String(row.provider_checkout_id)!==String(providerCheckoutId)) throw new Error('Provider checkout does not match the local checkout intent.');
    if (scope && row.scope!==scope) throw new Error('Checkout intent belongs to a different billing scope.');
    if (provider && row.provider!==provider) throw new Error('Checkout intent belongs to a different provider.');
    if (ownerId) {
        const actual=row.scope==='customer'?row.customer_id:row.reseller_id;
        if(String(actual)!==String(ownerId))throw new Error('Checkout intent belongs to a different account.');
    }
    return row;
}

async function verify({intentId,nonce,providerCheckoutId=null,scope=null,provider=null,ownerId=null}) {
    const result=await query('SELECT * FROM billing_checkout_intents WHERE id=$1',[intentId]);
    return verifyRow(result.rows[0],{nonce,providerCheckoutId,scope,provider,ownerId});
}

async function consume({ intentId, nonce, providerCheckoutId = null, state = 'completed', scope=null, provider=null, ownerId=null }) {
    if (!['completed','cancelled','failed'].includes(state)) throw new Error('Invalid checkout completion state.');
    return transaction(async client => {
        const result = await client.query('SELECT * FROM billing_checkout_intents WHERE id=$1 FOR UPDATE', [intentId]);
        const row=verifyRow(result.rows[0],{nonce,providerCheckoutId,scope,provider,ownerId});
        const updated = await client.query(`UPDATE billing_checkout_intents
            SET state=$2,completed_at=CASE WHEN $2='completed' THEN NOW() ELSE completed_at END,updated_at=NOW()
            WHERE id=$1 RETURNING *`, [intentId, state]);
        return updated.rows[0];
    });
}

// Used only after the corresponding webhook signature has been successfully
// verified. It intentionally does not accept unsigned browser input.
async function completeVerifiedProvider(provider, providerCheckoutId, state = 'completed') {
    if (!['stripe','paypal'].includes(provider)) throw new Error('Invalid checkout provider.');
    if (!['completed','cancelled','failed'].includes(state)) throw new Error('Invalid checkout completion state.');
    const result = await query(`UPDATE billing_checkout_intents
        SET state=$3,completed_at=CASE WHEN $3='completed' THEN NOW() ELSE completed_at END,updated_at=NOW()
        WHERE provider=$1 AND provider_checkout_id=$2 AND state='open' AND expires_at>NOW()
        RETURNING *`, [provider, String(providerCheckoutId || ''), state]);
    return result.rows[0] || null;
}

async function findProviderIntent(provider,providerCheckoutId){if(!['stripe','paypal'].includes(provider))return null;const r=await query(`SELECT * FROM billing_checkout_intents WHERE provider=$1 AND provider_checkout_id=$2 ORDER BY created_at DESC LIMIT 1`,[provider,String(providerCheckoutId||'')]);return r.rows[0]||null;}
async function getOpenForOwner(scope, ownerId) {
    const column = scope === 'customer' ? 'customer_id' : 'reseller_id';
    const result = await query(`SELECT * FROM billing_checkout_intents
        WHERE ${column}=$1 AND state='open' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`, [ownerId]);
    return result.rows[0] || null;
}

async function cancelForOwner(scope, ownerId) {
    const column = scope === 'customer' ? 'customer_id' : 'reseller_id';
    const result = await query(`UPDATE billing_checkout_intents SET state='cancelled',updated_at=NOW()
        WHERE ${column}=$1 AND state='open' RETURNING id`, [ownerId]);
    return result.rowCount;
}

module.exports = { createIntent, attachProviderCheckout, verify, consume, completeVerifiedProvider, findProviderIntent, getOpenForOwner, cancelForOwner, hash };
