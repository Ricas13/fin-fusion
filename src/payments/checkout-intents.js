'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');
const commerce = require('./commerce-control');
const serviceCreditReservations = require('./service-credit-reservations');
const capacity = require('../entitlements/plan-capacity');

const CHECKOUT_PROVIDERS = ['stripe', 'paypal', 'plisio'];

function hash(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }
function rawNonce() { return crypto.randomBytes(32).toString('base64url'); }
function safeSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, 'utf8') > 32768) throw new Error('Checkout commercial snapshot is too large.');
    return value;
}
function cleanProviderCheckoutId(value) {
    const id = String(value || '').trim().slice(0, 300);
    if (!id) {
        const error = new Error('Provider checkout ID is required.');
        error.code = 'PROVIDER_CHECKOUT_ID_REQUIRED';
        throw error;
    }
    return id;
}
function identityError(message, code = 'PROVIDER_CHECKOUT_IDENTITY_CONFLICT') {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function lockCheckoutOwner(client, customerId) {
    if (!customerId) throw new Error('Checkout owner is required.');
    const row = await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
    if (!row.rowCount) throw new Error('Checkout owner no longer exists.');
}

async function settleReservation(client, intentId, state) {
    if (!intentId) return;
    const intent = (await client.query(
        'SELECT provider_checkout_id FROM billing_checkout_intents WHERE id=$1',
        [intentId]
    )).rows[0];
    const attached = Boolean(String(intent?.provider_checkout_id || '').trim());

    if (state === 'completed') {
        await client.query(`
            UPDATE discount_checkout_reservations
            SET state='consumed',consumed_at=COALESCE(consumed_at,NOW()),updated_at=NOW()
            WHERE checkout_intent_id=$1 AND state IN('reserved','released','expired')
        `, [intentId]);
        await serviceCreditReservations.settle(client, intentId, 'completed');
        return;
    }

    if (state === 'expired') {
        await client.query(`
            UPDATE discount_checkout_reservations
            SET state='expired',updated_at=NOW()
            WHERE checkout_intent_id=$1 AND state='reserved'
        `, [intentId]);
        await serviceCreditReservations.settle(client, intentId, 'expired');
        return;
    }

    if (state === 'cancelled' && attached) {
        // A browser-side cancellation is not provider proof that an already-created
        // checkout cannot still settle. Keep frozen discounts/service credit protected
        // until provider truth or the reservation expiry closes that race.
        await serviceCreditReservations.settle(client, intentId, 'cancelled_attached');
        return;
    }

    if (['cancelled', 'failed'].includes(state)) {
        await client.query(`
            UPDATE discount_checkout_reservations
            SET state='released',released_at=COALESCE(released_at,NOW()),updated_at=NOW()
            WHERE checkout_intent_id=$1 AND state='reserved'
        `, [intentId]);
        await serviceCreditReservations.settle(client, intentId, state);
    }
}

function providerMaxTtl(provider) { return provider === 'plisio' ? 180 : 60; }

async function createIntent({
    scope, customerId = null, planId = null, planPriceId = null, provider,
    checkoutMode = 'subscription', ttlMinutes = 30, commercialSnapshot = {}
}) {
    await commerce.assertOpen();
    if (scope !== 'customer') throw new Error('Invalid checkout scope.');
    if (!CHECKOUT_PROVIDERS.includes(provider)) throw new Error('Invalid checkout provider.');
    if (!['payment', 'subscription'].includes(checkoutMode)) throw new Error('Invalid checkout mode.');
    const nonce = rawNonce();
    const snapshot = safeSnapshot(commercialSnapshot);
    const maxTtl = providerMaxTtl(provider);
    const expires = new Date(Date.now() + Math.max(5, Math.min(maxTtl, Number(ttlMinutes) || 30)) * 60000);
    if (planPriceId && String(snapshot.planPriceId || '') !== String(planPriceId)) {
        throw new Error('Checkout price does not match the commercial snapshot.');
    }

    const row = await transaction(async client => {
        if (!customerId) throw new Error('Checkout owner is required.');
        await lockCheckoutOwner(client, customerId);
        const expired = await client.query(`
            UPDATE billing_checkout_intents
            SET state='expired',updated_at=NOW()
            WHERE customer_id=$1 AND state='open' AND expires_at<=NOW()
            RETURNING id
        `, [customerId]);
        for (const x of expired.rows) await settleReservation(client, x.id, 'expired');

        const existing = await client.query(`
            SELECT id,provider,checkout_mode,expires_at
            FROM billing_checkout_intents
            WHERE customer_id=$1 AND state='open'
            LIMIT 1 FOR UPDATE
        `, [customerId]);
        if (existing.rowCount) throw new Error('A checkout is already in progress. Finish or cancel it before starting another one.');

        if (planId) {
            await capacity.lockAndAssert(client,planId,snapshot.planName || 'This plan', {
                streams:snapshot.streams,
                households:snapshot.stremioHouseholdNetworkLimit
            });
        }
        const created = await client.query(`
            INSERT INTO billing_checkout_intents(
                scope,customer_id,plan_id,plan_price_id,provider,checkout_mode,
                nonce_hash,expires_at,commercial_snapshot
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
            RETURNING *
        `, [scope, customerId, planId, planPriceId, provider, checkoutMode, hash(nonce), expires, JSON.stringify(snapshot)]);
        return created.rows[0];
    });
    return { ...row, nonce };
}

async function attachProviderCheckout(intentId, providerCheckoutId) {
    const externalId = cleanProviderCheckoutId(providerCheckoutId);
    return transaction(async client => {
        const intent = (await client.query(
            'SELECT * FROM billing_checkout_intents WHERE id=$1 FOR UPDATE',
            [intentId]
        )).rows[0];
        if (!intent || intent.state !== 'open') throw new Error('Checkout intent is no longer open.');

        const current = String(intent.provider_checkout_id || '').trim();
        if (current) {
            if (current === externalId) return intent;
            throw identityError(
                `Checkout intent ${intentId} is already bound to a different provider checkout.`,
                'PROVIDER_CHECKOUT_REBIND_CONFLICT'
            );
        }

        const collision = await client.query(`
            SELECT id
            FROM billing_checkout_intents
            WHERE provider=$1 AND provider_checkout_id=$2 AND id<>$3
            LIMIT 1
            FOR SHARE
        `, [intent.provider, externalId, intent.id]);
        if (collision.rowCount) {
            throw identityError('Provider checkout is already bound to a different local checkout intent.');
        }

        try {
            const result = await client.query(`
                UPDATE billing_checkout_intents
                SET provider_checkout_id=$2,updated_at=NOW()
                WHERE id=$1 AND provider_checkout_id IS NULL AND state='open'
                RETURNING *
            `, [intent.id, externalId]);
            if (!result.rowCount) throw identityError('Checkout provider binding changed concurrently.');
            return result.rows[0];
        } catch (error) {
            if (error?.code === '23505') {
                throw identityError('Provider checkout is already bound to a different local checkout intent.');
            }
            throw error;
        }
    });
}

function verifyRow(row, {
    nonce, providerCheckoutId = null, scope = null, provider = null, ownerId = null
} = {}) {
    if (!row) throw new Error('Checkout intent not found.');
    if (row.state !== 'open' || new Date(row.expires_at) <= new Date()) throw new Error('Checkout intent has expired or was already used.');
    if (!nonce || hash(nonce) !== row.nonce_hash) throw new Error('Checkout state verification failed.');
    if (providerCheckoutId && row.provider_checkout_id && String(row.provider_checkout_id) !== String(providerCheckoutId)) {
        throw new Error('Provider checkout does not match the local checkout intent.');
    }
    if (scope && row.scope !== scope) throw new Error('Checkout intent belongs to a different billing scope.');
    if (provider && row.provider !== provider) throw new Error('Checkout intent belongs to a different provider.');
    if (ownerId && String(row.customer_id) !== String(ownerId)) throw new Error('Checkout intent belongs to a different account.');
    return row;
}

async function findById(intentId) {
    if (!intentId) return null;
    const result = await query('SELECT * FROM billing_checkout_intents WHERE id=$1', [intentId]);
    return result.rows[0] || null;
}

async function verify({ intentId, nonce, providerCheckoutId = null, scope = null, provider = null, ownerId = null }) {
    return verifyRow(await findById(intentId), { nonce, providerCheckoutId, scope, provider, ownerId });
}

async function consume({
    intentId, nonce, providerCheckoutId = null, state = 'completed',
    scope = null, provider = null, ownerId = null
}) {
    if (!['completed', 'cancelled', 'failed'].includes(state)) throw new Error('Invalid checkout completion state.');
    return transaction(async client => {
        const candidate = (await client.query(
            'SELECT customer_id FROM billing_checkout_intents WHERE id=$1',
            [intentId]
        )).rows[0];
        if (!candidate) throw new Error('Checkout intent not found.');
        await lockCheckoutOwner(client, candidate.customer_id);
        const result = await client.query(
            'SELECT * FROM billing_checkout_intents WHERE id=$1 FOR UPDATE',
            [intentId]
        );
        const row = verifyRow(result.rows[0], { nonce, providerCheckoutId, scope, provider, ownerId });
        const updated = await client.query(`
            UPDATE billing_checkout_intents
            SET state=$2,
                completed_at=CASE WHEN $2='completed' THEN NOW() ELSE completed_at END,
                updated_at=NOW()
            WHERE id=$1
            RETURNING *
        `, [intentId, state]);
        await settleReservation(client, intentId, state);
        return updated.rows[0];
    });
}

async function completeVerifiedProvider(provider, providerCheckoutId, state = 'completed') {
    if (!CHECKOUT_PROVIDERS.includes(provider)) throw new Error('Invalid checkout provider.');
    if (!['completed', 'cancelled', 'failed'].includes(state)) throw new Error('Invalid checkout completion state.');
    const externalId = cleanProviderCheckoutId(providerCheckoutId);
    return transaction(async client => {
        const candidate = (await client.query(`
            SELECT id,customer_id
            FROM billing_checkout_intents
            WHERE provider=$1 AND provider_checkout_id=$2
            ORDER BY created_at DESC LIMIT 1
        `, [provider, externalId])).rows[0];
        if (!candidate) return null;
        await lockCheckoutOwner(client, candidate.customer_id);
        const result = await client.query(`
            SELECT *
            FROM billing_checkout_intents
            WHERE id=$1 AND provider=$2 AND provider_checkout_id=$3
            FOR UPDATE
        `, [candidate.id, provider, externalId]);
        if (!result.rowCount) return null;
        const row = result.rows[0];
        if (row.state === state) return row;
        if (row.state === 'completed') return row;
        if (state !== 'completed' && row.state !== 'open') return row;
        const updated = await client.query(`
            UPDATE billing_checkout_intents
            SET state=$2,
                completed_at=CASE WHEN $2='completed' THEN COALESCE(completed_at,NOW()) ELSE completed_at END,
                updated_at=NOW()
            WHERE id=$1
            RETURNING *
        `, [row.id, state]);
        await settleReservation(client, row.id, state);
        return updated.rows[0];
    });
}

async function findProviderIntent(provider, providerCheckoutId) {
    if (!CHECKOUT_PROVIDERS.includes(provider)) return null;
    const externalId = String(providerCheckoutId || '').trim().slice(0, 300);
    if (!externalId) return null;
    const r = await query(`
        SELECT *
        FROM billing_checkout_intents
        WHERE provider=$1 AND provider_checkout_id=$2
        ORDER BY created_at DESC LIMIT 1
    `, [provider, externalId]);
    return r.rows[0] || null;
}

async function findOrAttachProviderIntent({
    provider, providerCheckoutId, scope = 'customer', ownerId = null,
    planId = null, checkoutMode = null
}) {
    const externalId = cleanProviderCheckoutId(providerCheckoutId);
    let row = await findProviderIntent(provider, externalId);
    if (row || !ownerId || !planId || !checkoutMode) return row;

    return transaction(async client => {
        const existing = await client.query(`
            SELECT *
            FROM billing_checkout_intents
            WHERE provider=$1 AND provider_checkout_id=$2
            ORDER BY created_at DESC LIMIT 1
            FOR UPDATE
        `, [provider, externalId]);
        if (existing.rowCount) return existing.rows[0];

        const candidate = await client.query(`
            SELECT *
            FROM billing_checkout_intents
            WHERE provider=$1 AND scope=$2 AND customer_id=$3 AND plan_id=$4
              AND checkout_mode=$5 AND state='open' AND expires_at>NOW()
              AND provider_checkout_id IS NULL
            ORDER BY created_at DESC LIMIT 2
            FOR UPDATE
        `, [provider, scope, ownerId, planId, checkoutMode]);
        if (candidate.rowCount !== 1) return null;

        const collision = await client.query(`
            SELECT id FROM billing_checkout_intents
            WHERE provider=$1 AND provider_checkout_id=$2 AND id<>$3
            LIMIT 1 FOR SHARE
        `, [provider, externalId, candidate.rows[0].id]);
        if (collision.rowCount) throw identityError('Provider checkout is already bound to a different local checkout intent.');

        try {
            const attached = await client.query(`
                UPDATE billing_checkout_intents
                SET provider_checkout_id=$2,updated_at=NOW()
                WHERE id=$1 AND state='open' AND provider_checkout_id IS NULL
                RETURNING *
            `, [candidate.rows[0].id, externalId]);
            return attached.rows[0] || null;
        } catch (error) {
            if (error?.code === '23505') throw identityError('Provider checkout is already bound to a different local checkout intent.');
            throw error;
        }
    });
}

function asMoney(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
}
function normalizeCurrency(value) { return String(value || '').trim().toUpperCase(); }

async function verifiedProviderContract({
    provider, providerCheckoutId, scope = 'customer', ownerId = null,
    planId = null, checkoutMode = null, providerMappingId = null,
    amountMinor = null, currency = null
}) {
    const row = await findOrAttachProviderIntent({
        provider, providerCheckoutId, scope, ownerId, planId, checkoutMode
    });
    if (!row) throw new Error('Verified provider checkout has no matching local checkout intent.');
    if (row.provider !== provider) throw new Error('Provider checkout belongs to a different provider.');
    if (scope && row.scope !== scope) throw new Error('Provider checkout belongs to a different billing scope.');
    if (ownerId && String(row.customer_id) !== String(ownerId)) throw new Error('Provider checkout belongs to a different account.');
    if (planId && String(row.plan_id || '') !== String(planId)) throw new Error('Provider checkout plan does not match the local checkout contract.');
    if (checkoutMode && row.checkout_mode !== checkoutMode) throw new Error('Provider checkout mode does not match the local checkout contract.');
    const snapshot = safeSnapshot(row.commercial_snapshot || {});
    if (snapshot.kind !== 'direct_plan' || String(snapshot.planId || '') !== String(row.plan_id || '')) {
        throw new Error('Checkout commercial snapshot is incomplete or does not match its plan.');
    }
    if (row.plan_price_id && String(snapshot.planPriceId || '') !== String(row.plan_price_id)) {
        throw new Error('Checkout commercial snapshot does not match its selected plan price.');
    }
    if (snapshot.provider !== provider || snapshot.checkoutMode !== row.checkout_mode) {
        throw new Error('Checkout commercial snapshot provider terms do not match the local intent.');
    }
    if (providerMappingId && String(snapshot.providerMappingId || '') !== String(providerMappingId)) {
        throw new Error('Provider price/plan does not match the checkout contract.');
    }
    const expectedMinor = asMoney(snapshot.discountedMinor ?? snapshot.priceMinor);
    const actualMinor = amountMinor == null ? null : asMoney(amountMinor);
    if (actualMinor != null && expectedMinor != null && actualMinor !== expectedMinor) {
        throw new Error(`Provider amount ${actualMinor} does not match checkout contract amount ${expectedMinor}.`);
    }
    const expectedCurrency = normalizeCurrency(snapshot.currency);
    const actualCurrency = currency == null ? '' : normalizeCurrency(currency);
    if (actualCurrency && expectedCurrency && actualCurrency !== expectedCurrency) {
        throw new Error(`Provider currency ${actualCurrency} does not match checkout contract currency ${expectedCurrency}.`);
    }
    return { intent: row, snapshot: { ...snapshot, checkoutIntentId:row.id } };
}

async function alreadyCompletedByOwner({ intentId, nonce, scope = null, provider = null, ownerId = null }) {
    if (!intentId || !nonce) return null;
    const row = await findById(intentId);
    if (!row || row.state !== 'completed') return null;
    if (hash(nonce) !== row.nonce_hash) return null;
    if (scope && row.scope !== scope) return null;
    if (provider && row.provider !== provider) return null;
    if (ownerId && String(row.customer_id) !== String(ownerId)) return null;
    return row;
}

async function getOpenForOwner(scope, ownerId) {
    const result = await query(`
        SELECT *
        FROM billing_checkout_intents
        WHERE customer_id=$1 AND state='open' AND expires_at>NOW()
        ORDER BY created_at DESC LIMIT 1
    `, [ownerId]);
    return result.rows[0] || null;
}

async function cancelForOwner(scope, ownerId) {
    return transaction(async client => {
        await lockCheckoutOwner(client, ownerId);
        const rows = await client.query(`
            SELECT id
            FROM billing_checkout_intents
            WHERE customer_id=$1 AND state='open'
            FOR UPDATE
        `, [ownerId]);
        if (!rows.rowCount) return 0;
        const result = await client.query(`
            UPDATE billing_checkout_intents
            SET state='cancelled',updated_at=NOW()
            WHERE customer_id=$1 AND state='open'
            RETURNING id
        `, [ownerId]);
        for (const row of result.rows) await settleReservation(client, row.id, 'cancelled');
        return result.rowCount;
    });
}

module.exports = {
    CHECKOUT_PROVIDERS,
    createIntent,
    attachProviderCheckout,
    findById,
    verify,
    consume,
    completeVerifiedProvider,
    findProviderIntent,
    findOrAttachProviderIntent,
    verifiedProviderContract,
    alreadyCompletedByOwner,
    getOpenForOwner,
    cancelForOwner,
    hash,
    settleReservation,
    providerMaxTtl,
    cleanProviderCheckoutId
};
