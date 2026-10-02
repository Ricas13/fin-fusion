'use strict';

const { query, transaction } = require('../db');
const providerState = require('./provider-lifecycle-state');
const classifier = require('./provider-transaction-classifier');

const RESOURCE_TYPES = Object.freeze({
    CUSTOMER: 'customer',
    BILLING_REFERENCE: 'billing_reference',
    CHECKOUT: 'checkout',
    TRANSACTION: 'transaction',
    REFERENCE: 'reference',
    SOURCE: 'source'
});

function clean(value, max = 500) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeProvider(value) {
    return providerState.providerName(value);
}

function identityEvidence(values = {}) {
    const rows = [
        [RESOURCE_TYPES.CUSTOMER, values.providerCustomerId],
        [RESOURCE_TYPES.BILLING_REFERENCE, values.providerBillingReference || values.providerSubscriptionId],
        [RESOURCE_TYPES.CHECKOUT, values.providerCheckoutId],
        [RESOURCE_TYPES.TRANSACTION, values.providerTransactionId],
        [RESOURCE_TYPES.REFERENCE, values.providerReferenceId],
        [RESOURCE_TYPES.SOURCE, values.providerSourceId]
    ];
    const seen = new Set();
    return rows.map(([resourceType, raw]) => {
        const providerIdentity = clean(raw);
        if (!providerIdentity) return null;
        const key = resourceType + ':' + providerIdentity;
        if (seen.has(key)) return null;
        seen.add(key);
        return { resourceType, providerIdentity };
    }).filter(Boolean);
}

async function rememberIdentity({ provider, customerId, resourceType, providerIdentity, source = 'runtime', metadata = {} }, client = null) {
    const normalizedProvider = normalizeProvider(provider);
    const id = clean(providerIdentity);
    if (!customerId || !id) return null;
    const db = client || { query };
    const result = await db.query(`
        INSERT INTO payment_provider_identities(
            customer_id,provider,resource_type,provider_identity,source,metadata,first_seen_at,last_seen_at
        ) VALUES($1,$2,$3,$4,$5,$6::jsonb,NOW(),NOW())
        ON CONFLICT(provider,resource_type,provider_identity) DO UPDATE SET
            last_seen_at=NOW(),
            metadata=payment_provider_identities.metadata || EXCLUDED.metadata
        WHERE payment_provider_identities.customer_id=EXCLUDED.customer_id
        RETURNING customer_id
    `, [customerId, normalizedProvider, resourceType, id, clean(source, 100) || 'runtime', JSON.stringify(metadata || {})]);
    if (result.rowCount !== 1) {
        const error = new Error(`Provider identity ${normalizedProvider}:${resourceType}:${id} is already owned by another customer.`);
        error.code = 'PROVIDER_IDENTITY_CONFLICT';
        throw error;
    }
    return result.rows[0]?.customer_id || customerId;
}

async function rememberEvidence(values = {}, client = null) {
    if (!values.customerId) return 0;
    let remembered = 0;
    for (const item of identityEvidence(values)) {
        await rememberIdentity({
            provider: values.provider,
            customerId: values.customerId,
            resourceType: item.resourceType,
            providerIdentity: item.providerIdentity,
            source: values.identitySource || values.source || 'runtime',
            metadata: values.identityMetadata || {}
        }, client);
        remembered += 1;
    }
    return remembered;
}

async function customerExists(customerId) {
    if (!customerId) return false;
    const result = await query('SELECT id FROM customers WHERE id=$1 LIMIT 1', [customerId]);
    return result.rowCount === 1;
}

async function resolveCustomerId(values = {}) {
    const provider = normalizeProvider(values.provider);
    const explicit = clean(values.customerId);
    if (explicit && await customerExists(explicit)) return explicit;

    const ids = [...new Set(identityEvidence(values).map(row => row.providerIdentity))];
    const candidates = new Set();

    if (ids.length) {
        const identityRows = await query(`
            SELECT DISTINCT customer_id
            FROM payment_provider_identities
            WHERE provider=$1
              AND provider_identity=ANY($2::text[])
        `, [provider, ids]);
        for (const row of identityRows.rows) if (row.customer_id) candidates.add(String(row.customer_id));

        const subscriptionRows = await query(`
            SELECT DISTINCT customer_id
            FROM subscriptions
            WHERE source=$1
              AND (
                provider_customer_id=ANY($2::text[])
                OR provider_subscription_id=ANY($2::text[])
              )
        `, [provider, ids]);
        for (const row of subscriptionRows.rows) if (row.customer_id) candidates.add(String(row.customer_id));

        const checkoutRows = await query(`
            SELECT DISTINCT customer_id
            FROM billing_checkout_intents
            WHERE provider=$1
              AND customer_id IS NOT NULL
              AND (
                provider_checkout_id=ANY($2::text[])
                OR id::text=ANY($2::text[])
              )
        `, [provider, ids]);
        for (const row of checkoutRows.rows) if (row.customer_id) candidates.add(String(row.customer_id));

        const historyRows = await query(`
            SELECT DISTINCT customer_id
            FROM payment_history_transactions
            WHERE provider=$1
              AND customer_id IS NOT NULL
              AND (
                provider_transaction_id=ANY($2::text[])
                OR provider_customer_id=ANY($2::text[])
                OR provider_reference_id=ANY($2::text[])
                OR provider_source_id=ANY($2::text[])
              )
        `, [provider, ids]);
        for (const row of historyRows.rows) if (row.customer_id) candidates.add(String(row.customer_id));
    }

    const providerCustomerId = clean(values.providerCustomerId);
    if (providerCustomerId) {
        const mapped = await query(`
            SELECT DISTINCT customer_id
            FROM payment_customers
            WHERE provider=$1 AND provider_customer_id=$2
        `, [provider, providerCustomerId]);
        for (const row of mapped.rows) if (row.customer_id) candidates.add(String(row.customer_id));
    }

    const email = clean(values.email, 254).toLowerCase();
    if (!candidates.size && email) {
        const matched = await query(`
            SELECT DISTINCT c.id
            FROM customers c
            LEFT JOIN app_users u ON u.id=c.user_id
            WHERE lower(COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')))=$1
            LIMIT 2
        `, [email]);
        if (matched.rowCount === 1) candidates.add(String(matched.rows[0].id));
    }

    if (candidates.size > 1) {
        const error = new Error(`Provider identity evidence for ${provider} maps to multiple customers.`);
        error.code = 'PROVIDER_IDENTITY_CONFLICT';
        error.customerIds = [...candidates];
        throw error;
    }
    return candidates.size === 1 ? [...candidates][0] : null;
}

function authoritative(metadata) {
    return String(metadata?.providerAuthoritative || '').toLowerCase() === 'true' || metadata?.providerAuthoritative === true;
}

async function upsertTransaction(values = {}) {
    const provider = normalizeProvider(values.provider);
    const providerTransactionId = clean(values.providerTransactionId);
    const transactionType = clean(values.transactionType, 120);
    const transactionStatus = clean(values.transactionStatus, 120) || null;
    const currency = clean(values.currency, 8).toUpperCase();
    if (!providerTransactionId || !transactionType || !currency) throw new Error('Provider ledger transaction identity, type and currency are required.');

    const occurredAt = values.occurredAt ? new Date(values.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime())) throw new Error('Provider ledger transaction timestamp is invalid.');

    const number = (value, fallback = 0) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round(n) : fallback;
    };
    const grossMinor = number(values.grossMinor);
    const feeMinor = number(values.feeMinor);
    const netMinor = number(values.netMinor, grossMinor - feeMinor);
    const metadata = { ...(values.metadata || {}) };

    let customerId = values.customerId || null;
    if (!customerId) {
        customerId = await resolveCustomerId({
            ...values,
            provider,
            providerTransactionId
        });
    }

    return transaction(async client => {
        const incomingAuthoritative = authoritative(metadata);
        // A provider import can carry a more specific but still canonical
        // transaction category than a live webhook/capture normalizer. Keep it
        // when both representations classify to the same financial meaning;
        // replace malformed/unknown categories with the canonical incoming one.
        const existing = await client.query(`
            SELECT transaction_type,transaction_status,gross_amount_minor
            FROM payment_history_transactions
            WHERE provider=$1 AND provider_transaction_id=$2
            LIMIT 1
            FOR UPDATE
        `, [provider, providerTransactionId]);
        const existingRow = existing.rows[0] || null;
        const existingKind = existingRow ? classifier.classifyProviderTransaction({
            provider,
            type: existingRow.transaction_type,
            status: existingRow.transaction_status,
            grossMinor: existingRow.gross_amount_minor
        }) : null;
        const incomingKind = classifier.classifyProviderTransaction({
            provider,
            type: transactionType,
            status: transactionStatus,
            grossMinor
        });
        const effectiveTransactionType = existingKind && incomingKind && existingKind === incomingKind
            ? existingRow.transaction_type
            : transactionType;
        const result = await client.query(`
            INSERT INTO payment_history_transactions(
                provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
                gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,
                provider_reference_id,provider_source_id,customer_id,metadata
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
            ON CONFLICT(provider,provider_transaction_id) DO UPDATE SET
                transaction_type=CASE
                    WHEN COALESCE(payment_history_transactions.metadata->>'providerAuthoritative','false')='true'
                     AND COALESCE(EXCLUDED.metadata->>'providerAuthoritative','false')<>'true'
                    THEN payment_history_transactions.transaction_type ELSE EXCLUDED.transaction_type END,
                transaction_status=CASE
                    WHEN COALESCE(payment_history_transactions.metadata->>'providerAuthoritative','false')='true'
                     AND COALESCE(EXCLUDED.metadata->>'providerAuthoritative','false')<>'true'
                    THEN payment_history_transactions.transaction_status ELSE EXCLUDED.transaction_status END,
                occurred_at=CASE
                    WHEN COALESCE(payment_history_transactions.metadata->>'providerAuthoritative','false')='true'
                     AND COALESCE(EXCLUDED.metadata->>'providerAuthoritative','false')<>'true'
                    THEN payment_history_transactions.occurred_at ELSE EXCLUDED.occurred_at END,
                currency=CASE
                    WHEN COALESCE(payment_history_transactions.metadata->>'providerAuthoritative','false')='true'
                     AND COALESCE(EXCLUDED.metadata->>'providerAuthoritative','false')<>'true'
                    THEN payment_history_transactions.currency ELSE EXCLUDED.currency END,
                gross_amount_minor=CASE
                    WHEN COALESCE(payment_history_transactions.metadata->>'providerAuthoritative','false')='true'
                     AND COALESCE(EXCLUDED.metadata->>'providerAuthoritative','false')<>'true'
                    THEN payment_history_transactions.gross_amount_minor ELSE EXCLUDED.gross_amount_minor END,
                fee_amount_minor=CASE
                    WHEN COALESCE(payment_history_transactions.metadata->>'providerAuthoritative','false')='true'
                     AND COALESCE(EXCLUDED.metadata->>'providerAuthoritative','false')<>'true'
                    THEN payment_history_transactions.fee_amount_minor ELSE EXCLUDED.fee_amount_minor END,
                net_amount_minor=CASE
                    WHEN COALESCE(payment_history_transactions.metadata->>'providerAuthoritative','false')='true'
                     AND COALESCE(EXCLUDED.metadata->>'providerAuthoritative','false')<>'true'
                    THEN payment_history_transactions.net_amount_minor ELSE EXCLUDED.net_amount_minor END,
                provider_customer_id=COALESCE(EXCLUDED.provider_customer_id,payment_history_transactions.provider_customer_id),
                provider_reference_id=COALESCE(EXCLUDED.provider_reference_id,payment_history_transactions.provider_reference_id),
                provider_source_id=COALESCE(EXCLUDED.provider_source_id,payment_history_transactions.provider_source_id),
                customer_id=COALESCE(payment_history_transactions.customer_id,EXCLUDED.customer_id),
                metadata=CASE
                    WHEN COALESCE(payment_history_transactions.metadata->>'providerAuthoritative','false')='true'
                     AND COALESCE(EXCLUDED.metadata->>'providerAuthoritative','false')<>'true'
                    THEN COALESCE(payment_history_transactions.metadata,'{}'::jsonb)
                         || (COALESCE(EXCLUDED.metadata,'{}'::jsonb) - 'providerAuthoritative' - 'feeDataAvailable')
                    ELSE COALESCE(payment_history_transactions.metadata,'{}'::jsonb)
                         || COALESCE(EXCLUDED.metadata,'{}'::jsonb)
                END,
                updated_at=NOW()
            WHERE payment_history_transactions.customer_id IS NULL
               OR EXCLUDED.customer_id IS NULL
               OR payment_history_transactions.customer_id=EXCLUDED.customer_id
            RETURNING customer_id
        `, [
            provider, providerTransactionId, effectiveTransactionType, transactionStatus, occurredAt, currency,
            grossMinor, feeMinor, netMinor,
            clean(values.providerCustomerId) || null,
            clean(values.providerReferenceId) || null,
            clean(values.providerSourceId) || null,
            customerId,
            JSON.stringify({ ...metadata, providerAuthoritative: incomingAuthoritative })
        ]);
        if (result.rowCount !== 1) {
            const error = new Error(`Provider transaction ${provider}:${providerTransactionId} has an existing customer owner and is already owned by another customer.`);
            error.code = 'PROVIDER_TRANSACTION_OWNER_CONFLICT';
            throw error;
        }
        const owner = result.rows[0]?.customer_id || customerId || null;
        if (owner) {
            await rememberEvidence({
                ...values,
                provider,
                customerId: owner,
                providerTransactionId,
                identitySource: values.identitySource || 'provider_ledger'
            }, client);
        }
        return { provider, providerTransactionId, customerId: owner };
    });
}

async function seedLocalIdentities(customerId = null) {
    const params = customerId ? [customerId] : [];
    const customerClause = customerId ? ' AND customer_id=$1' : '';
    const sources = [
        {
            name: 'payment_customers',
            sql: `SELECT customer_id,provider,'customer'::text resource_type,provider_customer_id provider_identity,created_at seen_at
                  FROM payment_customers WHERE provider IN ('stripe','paypal','plisio')${customerClause}`
        },
        {
            name: 'subscriptions_customer',
            sql: `SELECT customer_id,source provider,'customer'::text resource_type,provider_customer_id provider_identity,created_at seen_at
                  FROM subscriptions WHERE source IN ('stripe','paypal','plisio') AND provider_customer_id IS NOT NULL${customerClause}`
        },
        {
            name: 'subscriptions_reference',
            sql: `SELECT customer_id,source provider,'billing_reference'::text resource_type,provider_subscription_id provider_identity,created_at seen_at
                  FROM subscriptions WHERE source IN ('stripe','paypal','plisio') AND provider_subscription_id IS NOT NULL${customerClause}`
        },
        {
            name: 'checkout',
            sql: `SELECT customer_id,provider,'checkout'::text resource_type,provider_checkout_id provider_identity,created_at seen_at
                  FROM billing_checkout_intents WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL AND provider_checkout_id IS NOT NULL${customerClause}`
        },
        {
            name: 'history_transaction',
            sql: `SELECT customer_id,provider,'transaction'::text resource_type,provider_transaction_id provider_identity,created_at seen_at
                  FROM payment_history_transactions WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL${customerClause}`
        },
        {
            name: 'history_customer',
            sql: `SELECT customer_id,provider,'customer'::text resource_type,provider_customer_id provider_identity,created_at seen_at
                  FROM payment_history_transactions WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL AND provider_customer_id IS NOT NULL${customerClause}`
        },
        {
            name: 'history_reference',
            sql: `SELECT customer_id,provider,'reference'::text resource_type,provider_reference_id provider_identity,created_at seen_at
                  FROM payment_history_transactions WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL AND provider_reference_id IS NOT NULL${customerClause}`
        },
        {
            name: 'history_source',
            sql: `SELECT customer_id,provider,'source'::text resource_type,provider_source_id provider_identity,created_at seen_at
                  FROM payment_history_transactions WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL AND provider_source_id IS NOT NULL${customerClause}`
        }
    ];

    let remembered = 0;
    for (const source of sources) {
        const result = await query(source.sql, params);
        for (const row of result.rows) {
            try {
                await rememberIdentity({
                    provider: row.provider,
                    customerId: row.customer_id,
                    resourceType: row.resource_type,
                    providerIdentity: row.provider_identity,
                    source: 'local_' + source.name
                });
                remembered += 1;
            } catch (error) {
                if (error.code !== 'PROVIDER_IDENTITY_CONFLICT') throw error;
            }
        }
    }
    return remembered;
}

async function linkUnownedTransactions(customerId = null) {
    const params = customerId ? [customerId] : [];
    const customerFilter = customerId ? ' AND i.customer_id=$1' : '';
    const checkoutFilter = customerId ? ' AND b.customer_id=$1' : '';
    const result = await query(`
        WITH candidates AS (
            SELECT t.id,i.customer_id
            FROM payment_history_transactions t
            JOIN payment_provider_identities i
              ON i.provider=t.provider
             AND i.provider_identity = ANY(ARRAY_REMOVE(ARRAY[
                    t.provider_customer_id,
                    t.provider_transaction_id,
                    t.provider_reference_id,
                    t.provider_source_id
                 ],NULL))
            WHERE t.customer_id IS NULL
              ${customerFilter}
            UNION ALL
            SELECT t.id,b.customer_id
            FROM payment_history_transactions t
            JOIN billing_checkout_intents b
              ON b.provider=t.provider
             AND b.customer_id IS NOT NULL
             AND (
                b.provider_checkout_id = ANY(ARRAY_REMOVE(ARRAY[
                    t.provider_transaction_id,
                    t.provider_reference_id,
                    t.provider_source_id
                ],NULL))
                OR b.id::text=COALESCE(t.metadata->>'checkoutIntentId',t.metadata->>'internal_checkout_intent_id')
             )
            WHERE t.customer_id IS NULL
              ${checkoutFilter}
        ),
        resolved AS (
            SELECT id,(ARRAY_AGG(DISTINCT customer_id))[1] customer_id
            FROM candidates
            GROUP BY id
            HAVING COUNT(DISTINCT customer_id)=1
        )
        UPDATE payment_history_transactions t
           SET customer_id=r.customer_id,
               metadata=t.metadata || jsonb_build_object('ownershipReconciled',TRUE),
               updated_at=NOW()
          FROM resolved r
         WHERE t.id=r.id AND t.customer_id IS NULL
        RETURNING t.id,t.customer_id
    `, params);
    return result.rows;
}

async function identityConflictCount(customerId = null) {
    const evidence = `
        SELECT customer_id,provider,'customer'::text resource_type,provider_customer_id provider_identity FROM payment_customers
        UNION ALL
        SELECT customer_id,source,'customer',provider_customer_id FROM subscriptions WHERE provider_customer_id IS NOT NULL
        UNION ALL
        SELECT customer_id,source,'billing_reference',provider_subscription_id FROM subscriptions WHERE provider_subscription_id IS NOT NULL
        UNION ALL
        SELECT customer_id,provider,'checkout',provider_checkout_id FROM billing_checkout_intents WHERE customer_id IS NOT NULL AND provider_checkout_id IS NOT NULL
        UNION ALL
        SELECT customer_id,provider,'transaction',provider_transaction_id FROM payment_history_transactions WHERE customer_id IS NOT NULL
        UNION ALL
        SELECT customer_id,provider,'customer',provider_customer_id FROM payment_history_transactions WHERE customer_id IS NOT NULL AND provider_customer_id IS NOT NULL
        UNION ALL
        SELECT customer_id,provider,'reference',provider_reference_id FROM payment_history_transactions WHERE customer_id IS NOT NULL AND provider_reference_id IS NOT NULL
        UNION ALL
        SELECT customer_id,provider,'source',provider_source_id FROM payment_history_transactions WHERE customer_id IS NOT NULL AND provider_source_id IS NOT NULL
    `;
    const result = customerId
        ? await query(`
            WITH evidence AS (${evidence}),
            relevant AS (
                SELECT DISTINCT provider,resource_type,provider_identity
                FROM evidence
                WHERE customer_id=$1
                  AND provider IN ('stripe','paypal','plisio')
                  AND provider_identity IS NOT NULL
            )
            SELECT COUNT(*)::int total
            FROM (
                SELECT e.provider,e.resource_type,e.provider_identity
                FROM evidence e
                JOIN relevant r
                  ON r.provider=e.provider
                 AND r.resource_type=e.resource_type
                 AND r.provider_identity=e.provider_identity
                GROUP BY e.provider,e.resource_type,e.provider_identity
                HAVING COUNT(DISTINCT e.customer_id)>1
            ) conflicts
        `, [customerId])
        : await query(`
            WITH evidence AS (${evidence})
            SELECT COUNT(*)::int total
            FROM (
                SELECT provider,resource_type,provider_identity
                FROM evidence
                WHERE provider IN ('stripe','paypal','plisio')
                  AND provider_identity IS NOT NULL
                GROUP BY provider,resource_type,provider_identity
                HAVING COUNT(DISTINCT customer_id)>1
            ) conflicts
        `);
    return Number(result.rows[0]?.total || 0);
}

async function unresolvedFinancialCount(customerId = null) {
    const stripePayments=[...classifier.STRIPE_PAYMENT_CATEGORIES];
    const stripeRefunds=[...classifier.STRIPE_REFUND_CATEGORIES];
    const paypalPayments=[...classifier.PAYPAL_PAYMENT_CODES];
    const paypalRefunds=[...classifier.PAYPAL_REFUND_CODES,'refund','reversal'];
    const plisioTypes=[...classifier.PLISIO_PAYMENT_TYPES,'refund','reversal'];
    const plisioStatuses=[...classifier.PLISIO_SUCCESS_STATUSES];
    const params=[stripePayments,stripeRefunds,paypalPayments,paypalRefunds,plisioTypes,plisioStatuses];
    let related='';
    if(customerId){
        params.push(customerId);
        related=`
          AND EXISTS (
            SELECT 1
            FROM payment_provider_identities i
            WHERE i.customer_id=$7
              AND i.provider=t.provider
              AND i.provider_identity = ANY(ARRAY_REMOVE(ARRAY[
                    t.provider_customer_id,t.provider_transaction_id,t.provider_reference_id,t.provider_source_id
                  ],NULL))
          )`;
    }
    const result=await query(`
        SELECT COUNT(*)::int total
        FROM payment_history_transactions t
        WHERE t.customer_id IS NULL
          AND (
            (t.provider='stripe' AND (
                (t.gross_amount_minor>0 AND lower(t.transaction_type)=ANY($1::text[]))
                OR (t.gross_amount_minor<0 AND lower(t.transaction_type)=ANY($2::text[]))
            ))
            OR
            (t.provider='paypal' AND upper(COALESCE(t.transaction_status,''))='S' AND (
                (t.gross_amount_minor>0 AND upper(t.transaction_type)=ANY($3::text[]))
                OR (t.gross_amount_minor<0 AND (
                    upper(t.transaction_type)=ANY($4::text[])
                    OR lower(t.transaction_type)=ANY($4::text[])
                ))
            ))
            OR
            (t.provider='plisio'
             AND lower(COALESCE(t.transaction_status,''))=ANY($6::text[])
             AND lower(t.transaction_type)=ANY($5::text[]))
          )
          ${related}
    `,params);
    return Number(result.rows[0]?.total||0);
}

async function repairOwnership({ customerId = null } = {}) {
    const rememberedBefore = await seedLocalIdentities(customerId);
    const linked = await linkUnownedTransactions(customerId);
    const rememberedAfter = linked.length ? await seedLocalIdentities(customerId) : 0;
    const [unmatched,conflicts] = await Promise.all([
        unresolvedFinancialCount(customerId),
        identityConflictCount(customerId)
    ]);
    return {
        remembered: rememberedBefore + rememberedAfter,
        linked: linked.length,
        unmatched,
        conflicts
    };
}

async function customerIdentities(customerId) {
    if (!customerId) return [];
    const result = await query(`
        SELECT provider,resource_type,provider_identity,source,first_seen_at,last_seen_at
        FROM payment_provider_identities
        WHERE customer_id=$1
        ORDER BY provider,resource_type,last_seen_at DESC,provider_identity
    `, [customerId]);
    return result.rows;
}

module.exports = {
    RESOURCE_TYPES,
    normalizeProvider,
    identityEvidence,
    rememberIdentity,
    rememberEvidence,
    resolveCustomerId,
    upsertTransaction,
    seedLocalIdentities,
    linkUnownedTransactions,
    identityConflictCount,
    unresolvedFinancialCount,
    repairOwnership,
    customerIdentities
};
