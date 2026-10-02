'use strict';

const { query } = require('../db');

const PROVIDERS = Object.freeze(['stripe','paypal','plisio']);
function providerName(value) {
    const provider = String(value || '').trim().toLowerCase();
    if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported financial provider: ${provider || 'unknown'}`);
    return provider;
}
function text(value) { const out=String(value==null?'':value).trim(); return out||null; }

async function recordTransaction(input) {
    const provider=providerName(input.provider);
    const providerTransactionId=text(input.providerTransactionId);
    const transactionType=text(input.transactionType);
    const currency=String(input.currency||'').trim().toUpperCase();
    const occurredAt=input.occurredAt?new Date(input.occurredAt):new Date();
    const gross=Number(input.grossMinor),fee=Number(input.feeMinor||0),net=Number(input.netMinor==null?gross-fee:input.netMinor);
    if(!providerTransactionId||!transactionType||!/^[A-Z]{3}$/.test(currency)||Number.isNaN(occurredAt.getTime())||![gross,fee,net].every(Number.isFinite))throw new Error('Invalid provider financial transaction.');
    const result=await query(`
      INSERT INTO payment_history_transactions(
        provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
        gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,
        provider_reference_id,provider_source_id,customer_id,metadata
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
      ON CONFLICT(provider,provider_transaction_id) DO UPDATE SET
        transaction_type=EXCLUDED.transaction_type,
        transaction_status=COALESCE(EXCLUDED.transaction_status,payment_history_transactions.transaction_status),
        occurred_at=EXCLUDED.occurred_at,
        currency=EXCLUDED.currency,
        gross_amount_minor=EXCLUDED.gross_amount_minor,
        fee_amount_minor=EXCLUDED.fee_amount_minor,
        net_amount_minor=EXCLUDED.net_amount_minor,
        provider_customer_id=COALESCE(EXCLUDED.provider_customer_id,payment_history_transactions.provider_customer_id),
        provider_reference_id=COALESCE(EXCLUDED.provider_reference_id,payment_history_transactions.provider_reference_id),
        provider_source_id=COALESCE(EXCLUDED.provider_source_id,payment_history_transactions.provider_source_id),
        customer_id=COALESCE(payment_history_transactions.customer_id,EXCLUDED.customer_id),
        metadata=COALESCE(payment_history_transactions.metadata,'{}'::jsonb)||COALESCE(EXCLUDED.metadata,'{}'::jsonb),
        updated_at=NOW()
      WHERE payment_history_transactions.customer_id IS NULL
         OR EXCLUDED.customer_id IS NULL
         OR payment_history_transactions.customer_id=EXCLUDED.customer_id
      RETURNING *
    `,[
      provider,providerTransactionId,transactionType,text(input.transactionStatus),occurredAt,currency,
      Math.round(gross),Math.round(fee),Math.round(net),text(input.providerCustomerId),
      text(input.providerReferenceId),text(input.providerSourceId),text(input.customerId),
      JSON.stringify(input.metadata&&typeof input.metadata==='object'?input.metadata:{})
    ]);
    if(result.rowCount!==1){const error=new Error(`${provider} transaction ${providerTransactionId} conflicts with an existing customer owner.`);error.code='PROVIDER_FINANCIAL_OWNER_CONFLICT';throw error;}
    return result.rows[0];
}

async function backfillProviderCustomers() {
    const result=await query(`
      WITH ranked AS (
        SELECT DISTINCT ON (s.customer_id,s.source)
               s.customer_id,s.source AS provider,s.provider_customer_id,s.created_at
        FROM subscriptions s
        WHERE s.source IN ('stripe','paypal')
          AND NULLIF(BTRIM(COALESCE(s.provider_customer_id,'')),'') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM payment_customers x
            WHERE x.provider=s.source
              AND x.provider_customer_id=s.provider_customer_id
              AND x.customer_id<>s.customer_id
          )
        ORDER BY s.customer_id,s.source,s.created_at DESC
      )
      INSERT INTO payment_customers(customer_id,provider,provider_customer_id)
      SELECT customer_id,provider,provider_customer_id FROM ranked
      ON CONFLICT(customer_id,provider) DO UPDATE
        SET provider_customer_id=EXCLUDED.provider_customer_id,updated_at=NOW()
      WHERE payment_customers.provider_customer_id IS DISTINCT FROM EXCLUDED.provider_customer_id
      RETURNING customer_id
    `);
    return result.rowCount;
}

async function backfillPlisioTransactions() {
    const result=await query(`
      INSERT INTO payment_history_transactions(
        provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
        gross_amount_minor,fee_amount_minor,net_amount_minor,customer_id,provider_reference_id,metadata
      )
      SELECT 'plisio',s.provider_subscription_id,'payment','completed',COALESCE(s.starts_at,s.created_at),
             UPPER(COALESCE(s.currency_snapshot,p.currency,'USD')),
             CASE WHEN COALESCE(s.commercial_snapshot->>'discountedMinor','') ~ '^[0-9]+$'
                  THEN (s.commercial_snapshot->>'discountedMinor')::bigint
                  ELSE COALESCE(s.price_minor_snapshot,p.price_minor,0)::bigint END,
             0,
             CASE WHEN COALESCE(s.commercial_snapshot->>'discountedMinor','') ~ '^[0-9]+$'
                  THEN (s.commercial_snapshot->>'discountedMinor')::bigint
                  ELSE COALESCE(s.price_minor_snapshot,p.price_minor,0)::bigint END,
             s.customer_id,s.id::text,
             jsonb_build_object('providerVerified',TRUE,'providerAuthoritative',TRUE,'feeDataAvailable',FALSE,'source','activated_subscription')
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.source='plisio'
        AND NULLIF(BTRIM(COALESCE(s.provider_subscription_id,'')),'') IS NOT NULL
        AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
      ON CONFLICT(provider,provider_transaction_id) DO UPDATE SET
        customer_id=COALESCE(payment_history_transactions.customer_id,EXCLUDED.customer_id),
        provider_reference_id=COALESCE(payment_history_transactions.provider_reference_id,EXCLUDED.provider_reference_id),
        metadata=COALESCE(payment_history_transactions.metadata,'{}'::jsonb)||EXCLUDED.metadata,
        updated_at=NOW()
      WHERE payment_history_transactions.customer_id IS NULL
         OR payment_history_transactions.customer_id=EXCLUDED.customer_id
      RETURNING id
    `);
    return result.rowCount;
}

async function repairLinks({limit=5000}={}) {
    const safe=Math.max(1,Math.min(50000,Number(limit)||5000));
    const result=await query(`
      WITH evidence AS (
        SELECT t.id,pc.customer_id
          FROM payment_history_transactions t
          JOIN payment_customers pc ON pc.provider=t.provider AND pc.provider_customer_id=t.provider_customer_id
         WHERE t.customer_id IS NULL AND t.provider_customer_id IS NOT NULL
        UNION ALL
        SELECT t.id,s.customer_id
          FROM payment_history_transactions t
          JOIN subscriptions s ON s.source=t.provider AND s.provider_customer_id=t.provider_customer_id
         WHERE t.customer_id IS NULL AND t.provider_customer_id IS NOT NULL
        UNION ALL
        SELECT t.id,s.customer_id
          FROM payment_history_transactions t
          JOIN subscriptions s ON s.source=t.provider
           AND s.provider_subscription_id IN (t.provider_transaction_id,t.provider_reference_id,t.provider_source_id)
         WHERE t.customer_id IS NULL AND s.provider_subscription_id IS NOT NULL
        UNION ALL
        SELECT t.id,i.customer_id
          FROM payment_history_transactions t
          JOIN billing_checkout_intents i ON i.provider=t.provider
           AND (
             i.provider_checkout_id IN (t.provider_transaction_id,t.provider_reference_id,t.provider_source_id)
             OR i.id::text=COALESCE(t.metadata->>'checkoutIntentId',t.metadata->>'internal_checkout_intent_id')
           )
         WHERE t.customer_id IS NULL
        UNION ALL
        SELECT t.id,c.id
          FROM payment_history_transactions t
          JOIN customers c ON c.id::text=COALESCE(t.metadata->>'customerId',t.metadata->>'internal_customer_id')
         WHERE t.customer_id IS NULL
      ),
      resolved AS (
        SELECT id,MIN(customer_id::text)::uuid customer_id
          FROM evidence
         GROUP BY id
        HAVING COUNT(DISTINCT customer_id)=1
         LIMIT $1
      )
      UPDATE payment_history_transactions t
         SET customer_id=r.customer_id,
             metadata=COALESCE(t.metadata,'{}'::jsonb)||jsonb_build_object('customerLinkReconciled',TRUE),
             updated_at=NOW()
        FROM resolved r
       WHERE t.id=r.id AND t.customer_id IS NULL
      RETURNING t.id
    `,[safe]);
    return result.rowCount;
}

async function reconcileLocalEvidence(options={}) {
    const providerCustomers=await backfillProviderCustomers();
    const plisio=await backfillPlisioTransactions();
    const linked=await repairLinks(options);
    return{providerCustomers,plisio,linked,processed:providerCustomers+plisio+linked,failed:0};
}

async function customerSnapshot(customerId) {
    const [identities,transactions,incidents,unlinked]=await Promise.all([
      query(`
        SELECT provider,provider_customer_id,MIN(source_rank) source_rank
        FROM (
          SELECT provider,provider_customer_id,0 source_rank FROM payment_customers WHERE customer_id=$1
          UNION ALL
          SELECT source AS provider,provider_customer_id,1 source_rank FROM subscriptions
           WHERE customer_id=$1 AND source IN ('stripe','paypal','plisio') AND provider_customer_id IS NOT NULL
        ) x
        WHERE provider_customer_id IS NOT NULL
        GROUP BY provider,provider_customer_id
        ORDER BY provider,source_rank,provider_customer_id
      `,[customerId]),
      query(`SELECT provider,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor,fee_amount_minor,net_amount_minor,provider_transaction_id,provider_reference_id,provider_source_id,provider_customer_id,metadata FROM payment_history_transactions WHERE customer_id=$1 ORDER BY occurred_at DESC LIMIT 100`,[customerId]),
      query(`SELECT provider,provider_case_id,incident_type,incident_status,created_at,resolved_at FROM payment_incidents WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[customerId]),
      query(`
        SELECT COUNT(DISTINCT t.id)::int AS count
        FROM payment_history_transactions t
        WHERE t.customer_id IS NULL AND (
          EXISTS(SELECT 1 FROM payment_customers pc WHERE pc.customer_id=$1 AND pc.provider=t.provider AND pc.provider_customer_id=t.provider_customer_id)
          OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=$1 AND s.source=t.provider AND (
              s.provider_customer_id=t.provider_customer_id OR
              s.provider_subscription_id IN (t.provider_transaction_id,t.provider_reference_id,t.provider_source_id)
          ))
          OR EXISTS(SELECT 1 FROM billing_checkout_intents i WHERE i.customer_id=$1 AND i.provider=t.provider AND (
              i.provider_checkout_id IN (t.provider_transaction_id,t.provider_reference_id,t.provider_source_id)
              OR i.id::text=COALESCE(t.metadata->>'checkoutIntentId',t.metadata->>'internal_checkout_intent_id')
          ))
        )
      `,[customerId])
    ]);
    return{identities:identities.rows,transactions:transactions.rows,incidents:incidents.rows,unlinkedCount:Number(unlinked.rows[0]?.count||0)};
}

module.exports={PROVIDERS,providerName,recordTransaction,backfillProviderCustomers,backfillPlisioTransactions,repairLinks,reconcileLocalEvidence,customerSnapshot};
