'use strict';

const { query } = require('../db');

const PROVIDERS = Object.freeze(['stripe','paypal','plisio']);
const MAX_QUERY_ROWS = 300000;

function providerName(value) {
    const provider = String(value || '').trim().toLowerCase();
    if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported financial provider: ${provider || 'unknown'}`);
    return provider;
}
function text(value) { const out=String(value==null?'':value).trim(); return out||null; }
function boundedInt(value,{min=0,max=MAX_QUERY_ROWS,fallback=0}={}) {
    const parsed=Number.parseInt(value,10);
    if(!Number.isFinite(parsed))return fallback;
    return Math.max(min,Math.min(max,parsed));
}

function transactionSelect() {
    return `SELECT t.id,t.provider,t.provider_transaction_id,t.transaction_type,t.transaction_status,t.occurred_at,t.currency,
                   t.gross_amount_minor,t.fee_amount_minor,t.net_amount_minor,t.provider_customer_id,t.provider_reference_id,
                   t.provider_source_id,t.customer_id,t.metadata,
                   COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')) AS customer_email,
                   c.display_name,u.username AS portal_username
              FROM payment_history_transactions t
              LEFT JOIN customers c ON c.id=t.customer_id
              LEFT JOIN app_users u ON u.id=c.user_id`;
}

function transactionWhere(filters={},params=[]) {
    const clauses=['1=1'];
    const add=value=>{params.push(value);return `$${params.length}`;};
    const provider=String(filters.provider||'').trim().toLowerCase();
    if(provider&&provider!=='all')clauses.push(`t.provider=${add(providerName(provider))}`);
    const currency=String(filters.currency||'').trim().toUpperCase();
    if(currency)clauses.push(`UPPER(t.currency)=${add(currency)}`);
    const status=String(filters.status||'').trim();
    if(status)clauses.push(`LOWER(COALESCE(t.transaction_status,''))=LOWER(${add(status)})`);
    if(filters.startDate)clauses.push(`t.occurred_at>=${add(filters.startDate)}::date`);
    if(filters.endDate)clauses.push(`t.occurred_at<(${add(filters.endDate)}::date + INTERVAL '1 day')`);
    if(filters.startAt)clauses.push(`t.occurred_at>=${add(filters.startAt)}`);
    if(filters.endAt)clauses.push(`t.occurred_at<${add(filters.endAt)}`);
    if(filters.customerId)clauses.push(`t.customer_id=${add(String(filters.customerId))}`);
    if(Array.isArray(filters.providerTransactionIds)&&filters.providerTransactionIds.length){
        const ids=[...new Set(filters.providerTransactionIds.map(value=>String(value||'').trim()).filter(Boolean))];
        if(ids.length)clauses.push(`t.provider_transaction_id=ANY(${add(ids)}::text[])`);
    }
    if(filters.providerAuthoritative===true)clauses.push("COALESCE(t.metadata->>'providerAuthoritative','false')='true'");
    if(filters.feeDataAvailable===true)clauses.push("COALESCE(t.metadata->>'feeDataAvailable','false')='true'");
    if(filters.feeDataAvailable===false)clauses.push("COALESCE(t.metadata->>'feeDataAvailable','false')<>'true'");
    if(filters.unowned===true)clauses.push('t.customer_id IS NULL');
    const q=String(filters.q||'').trim();
    if(q){
        const p=add(`%${q}%`);
        clauses.push(`(
            COALESCE(c.email,'') ILIKE ${p} OR COALESCE(c.display_name,'') ILIKE ${p} OR COALESCE(u.username,'') ILIKE ${p}
            OR COALESCE(t.provider_transaction_id,'') ILIKE ${p} OR COALESCE(t.provider_customer_id,'') ILIKE ${p}
            OR COALESCE(t.provider_reference_id,'') ILIKE ${p} OR COALESCE(t.provider_source_id,'') ILIKE ${p}
            OR COALESCE(t.transaction_type,'') ILIKE ${p}
        )`);
    }
    return clauses.join(' AND ');
}

async function queryTransactions(filters={},options={}) {
    const queryFn=options.queryFn||query;
    const params=[];
    const where=transactionWhere(filters,params);
    const limit=boundedInt(options.limit,{min:1,max:MAX_QUERY_ROWS,fallback:100});
    const offset=boundedInt(options.offset,{min:0,max:Number.MAX_SAFE_INTEGER,fallback:0});
    const direction=String(options.order||'desc').toLowerCase()==='asc'?'ASC':'DESC';
    params.push(limit,offset);
    return queryFn(`${transactionSelect()} WHERE ${where} ORDER BY t.occurred_at ${direction},t.id ${direction} LIMIT $${params.length-1} OFFSET $${params.length}`,params);
}

async function countTransactions(filters={},options={}) {
    const queryFn=options.queryFn||query;
    const params=[];
    const where=transactionWhere(filters,params);
    const result=await queryFn(`SELECT COUNT(*)::bigint AS total FROM payment_history_transactions t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN app_users u ON u.id=c.user_id WHERE ${where}`,params);
    return Number(result.rows[0]?.total||0);
}

async function missingPlisioFeeTransactions(limit=25,options={}) {
    const queryFn=options.queryFn||query;
    const safe=boundedInt(limit,{min:1,max:500,fallback:25});
    return queryFn(`${transactionSelect()}
      WHERE t.provider='plisio'
        AND LOWER(COALESCE(t.transaction_status,'')) IN ('completed','success','succeeded')
        AND COALESCE(t.metadata->>'feeDataAvailable','false')<>'true'
      ORDER BY
        CASE WHEN t.metadata ? 'feeReconcileAttemptedAt' THEN 1 ELSE 0 END ASC,
        COALESCE(t.metadata->>'feeReconcileAttemptedAt','') ASC,
        t.occurred_at DESC,t.id DESC
      LIMIT $1
    `,[safe]);
}

async function markPlisioFeeReconcileAttempt(providerTransactionId,error=null,options={}) {
    const queryFn=options.queryFn||query;
    const id=text(providerTransactionId);
    if(!id)return 0;
    const result=await queryFn(`
      UPDATE payment_history_transactions
      SET metadata=COALESCE(metadata,'{}'::jsonb)
          ||jsonb_build_object(
              'feeReconcileAttemptedAt',NOW(),
              'feeReconcileLastError',CASE WHEN $2::text IS NULL THEN NULL ELSE LEFT($2::text,500) END
            ),
          updated_at=NOW()
      WHERE provider='plisio' AND provider_transaction_id=$1
    `,[id,text(error)]);
    return result.rowCount;
}

async function latestPlisioCallbackEvidence(providerTransactionId,options={}) {
    const queryFn=options.queryFn||query;
    const id=text(providerTransactionId);
    if(!id)return null;
    const result=await queryFn(`
      SELECT payload
      FROM payment_events
      WHERE provider='plisio'
        AND payload->>'txn_id'=$1
        AND processed_at IS NOT NULL
        AND processing_error IS NULL
      ORDER BY created_at DESC,id DESC
      LIMIT 1
    `,[id]);
    const payload=result.rows[0]?.payload;
    return payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:null;
}

async function transactionCoverage(options={}) {
    const queryFn=options.queryFn||query;
    const result=await queryFn(`
        SELECT provider,COUNT(*)::bigint AS transactions,MIN(occurred_at) AS first_at,MAX(occurred_at) AS last_at,
               ARRAY_AGG(DISTINCT UPPER(currency) ORDER BY UPPER(currency)) AS currencies
          FROM payment_history_transactions
         GROUP BY provider
         ORDER BY provider
    `);
    return result.rows;
}

async function exportTransactions(limit=MAX_QUERY_ROWS,options={}) {
    const safe=boundedInt(limit,{min:1,max:MAX_QUERY_ROWS,fallback:MAX_QUERY_ROWS});
    const result=await queryTransactions({}, { ...options,limit:safe,offset:0,order:'asc' });
    return result.rows;
}

async function scanTransactionsInRange(range,visit,{queryFn=query,pageSize=5000,maxPages=1000,overflowMessage=null}={}) {
    if(typeof visit!=='function')throw new Error('Provider transaction scan requires a visitor.');
    const start=range?.previousStart||range?.start;
    const end=range?.end;
    if(!start||!end)throw new Error('Provider transaction scan requires start and end timestamps.');
    const size=boundedInt(pageSize,{min:1,max:50000,fallback:5000});
    const pages=boundedInt(maxPages,{min:1,max:10000,fallback:1000});
    let cursor=null,scanned=0;
    for(let page=0;page<pages;page+=1){
        const result=await queryFn(`
          SELECT provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
                 gross_amount_minor,fee_amount_minor,net_amount_minor,customer_id,provider_customer_id,metadata
            FROM payment_history_transactions
           WHERE occurred_at >= $1 AND occurred_at < $2
             AND ($3::timestamptz IS NULL OR (occurred_at,provider,provider_transaction_id) > ($3::timestamptz,$4::text,$5::text))
           ORDER BY occurred_at ASC,provider ASC,provider_transaction_id ASC
           LIMIT $6
        `,[start,end,cursor?.occurred_at||null,cursor?.provider||null,cursor?.provider_transaction_id||null,size]);
        for(const row of result.rows){await visit(row);scanned+=1;}
        if(result.rows.length<size)return scanned;
        cursor=result.rows[result.rows.length-1];
    }
    throw new Error(overflowMessage||`Provider transaction scan exceeded ${size*pages} rows.`);
}

async function resolveCustomerId(evidence={}) {
    const provider=providerName(evidence.provider);
    const claimed=text(evidence.internalCustomerId);
    if(claimed){
        const direct=await query('SELECT id FROM customers WHERE id=$1 LIMIT 1',[claimed]);
        if(direct.rowCount===1)return direct.rows[0].id;
    }

    const checkoutIntentId=text(evidence.checkoutIntentId);
    if(checkoutIntentId){
        const checkout=await query(`
          SELECT DISTINCT customer_id
          FROM billing_checkout_intents
          WHERE provider=$1 AND (id::text=$2 OR provider_checkout_id=$2)
          LIMIT 2
        `,[provider,checkoutIntentId]);
        const ids=[...new Set(checkout.rows.map(row=>String(row.customer_id||'')).filter(Boolean))];
        if(ids.length===1)return ids[0];
    }

    const references=[...(evidence.providerReferences||[]),evidence.providerReferenceId,evidence.providerSourceId,evidence.providerTransactionId]
      .map(value=>text(value)).filter(Boolean);
    if(references.length){
        const subscription=await query(`
          SELECT DISTINCT customer_id
          FROM subscriptions
          WHERE source=$1 AND provider_subscription_id=ANY($2::text[])
          LIMIT 2
        `,[provider,[...new Set(references)]]);
        const ids=[...new Set(subscription.rows.map(row=>String(row.customer_id||'')).filter(Boolean))];
        if(ids.length===1)return ids[0];

        if(provider==='stripe'){
            const legacy=await query(`
              SELECT DISTINCT customer_id
              FROM legacy_subscription_imports
              WHERE provider='stripe' AND provider_transaction_id=ANY($1::text[]) AND customer_id IS NOT NULL
              LIMIT 2
            `,[[...new Set(references)]]);
            const legacyIds=[...new Set(legacy.rows.map(row=>String(row.customer_id||'')).filter(Boolean))];
            if(legacyIds.length===1)return legacyIds[0];
        }
    }

    const providerCustomerId=text(evidence.providerCustomerId);
    if(providerCustomerId){
        const mapped=await query(`
          SELECT DISTINCT customer_id FROM (
            SELECT customer_id FROM payment_customers WHERE provider=$1 AND provider_customer_id=$2
            UNION ALL
            SELECT customer_id FROM subscriptions WHERE source=$1 AND provider_customer_id=$2
          ) candidates
          LIMIT 2
        `,[provider,providerCustomerId]);
        const ids=[...new Set(mapped.rows.map(row=>String(row.customer_id||'')).filter(Boolean))];
        if(ids.length===1)return ids[0];
    }

    const email=String(evidence.email||'').trim().toLowerCase();
    if(email){
        const matched=await query(`
          SELECT c.id
          FROM customers c
          LEFT JOIN app_users u ON u.id=c.user_id
          WHERE lower(COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')))=$1
          LIMIT 2
        `,[email]);
        if(matched.rowCount===1)return matched.rows[0].id;
    }
    return null;
}

async function scanAllTransactions(visit,{queryFn=query,pageSize=5000,maxPages=1000}={}) {
    if(typeof visit!=='function')throw new Error('Provider transaction scan requires a visitor.');
    const size=boundedInt(pageSize,{min:1,max:50000,fallback:5000});
    const pages=boundedInt(maxPages,{min:1,max:10000,fallback:1000});
    let cursor=null,scanned=0;
    for(let page=0;page<pages;page+=1){
        const result=await queryFn(`
          SELECT provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
                 gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,provider_reference_id,
                 provider_source_id,customer_id,metadata
            FROM payment_history_transactions
           WHERE ($1::timestamptz IS NULL OR (occurred_at,provider,provider_transaction_id) > ($1::timestamptz,$2::text,$3::text))
           ORDER BY occurred_at ASC,provider ASC,provider_transaction_id ASC
           LIMIT $4
        `,[cursor?.occurred_at||null,cursor?.provider||null,cursor?.provider_transaction_id||null,size]);
        for(const row of result.rows){await visit(row);scanned+=1;}
        if(result.rows.length<size)return scanned;
        cursor=result.rows[result.rows.length-1];
    }
    throw new Error(`Provider transaction scan exceeded ${size*pages} rows.`);
}

async function transactionsForCustomers(customerIds,{limit=MAX_QUERY_ROWS,order='desc'}={}) {
    const ids=[...new Set((customerIds||[]).map(value=>String(value||'').trim()).filter(Boolean))];
    if(!ids.length)return[];
    const safe=boundedInt(limit,{min:1,max:MAX_QUERY_ROWS,fallback:MAX_QUERY_ROWS});
    const direction=String(order||'desc').toLowerCase()==='asc'?'ASC':'DESC';
    const result=await query(`
      SELECT customer_id,provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
             gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,provider_reference_id,provider_source_id,metadata
      FROM payment_history_transactions
      WHERE customer_id=ANY($1::uuid[])
      ORDER BY occurred_at ${direction},id ${direction}
      LIMIT $2
    `,[ids,safe]);
    return result.rows;
}


function latestProviderIdentityJoinSql(customerExpression='c.id',alias='pay') {
    const customer=String(customerExpression||'').trim();
    const joinAlias=String(alias||'pay').trim();
    if(!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(customer))throw new Error('Invalid customer SQL expression.');
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(joinAlias))throw new Error('Invalid provider identity SQL alias.');
    return `LEFT JOIN LATERAL (
        SELECT identity.provider
        FROM (
            SELECT pc.provider,pc.updated_at,0 source_rank
            FROM payment_customers pc
            WHERE pc.customer_id=${customer}
            UNION ALL
            SELECT s.source AS provider,s.updated_at,1 source_rank
            FROM subscriptions s
            WHERE s.customer_id=${customer}
              AND s.source IN ('stripe','paypal','plisio')
              AND s.provider_customer_id IS NOT NULL
        ) identity
        ORDER BY identity.source_rank,identity.updated_at DESC NULLS LAST,identity.provider
        LIMIT 1
    ) ${joinAlias} ON TRUE`;
}

async function ensureProviderIdentity({customerId,provider,providerCustomerId}) {
    const id=text(providerCustomerId);
    if(!id)return null;
    const name=providerName(provider);
    const result=await query(`
      INSERT INTO payment_customers(customer_id,provider,provider_customer_id)
      VALUES($1,$2,$3)
      ON CONFLICT(customer_id,provider) DO UPDATE
        SET provider_customer_id=EXCLUDED.provider_customer_id,updated_at=NOW()
      RETURNING *
    `,[customerId,name,id]);
    return result.rows[0]||null;
}

async function findProviderIdentity(customerId,provider) {
    const result=await query(`
      SELECT * FROM payment_customers
      WHERE customer_id=$1 AND provider=$2
      LIMIT 1
    `,[customerId,providerName(provider)]);
    return result.rows[0]||null;
}

async function providerIdentityRows(providers=['stripe','paypal','plisio']) {
    const normalized=[...new Set((providers||[]).map(providerName))];
    if(!normalized.length)return[];
    const result=await query(`
      SELECT DISTINCT customer_id,provider,provider_customer_id
      FROM (
        SELECT customer_id,provider,provider_customer_id
          FROM payment_customers
         WHERE provider=ANY($1::text[]) AND provider_customer_id IS NOT NULL
        UNION ALL
        SELECT customer_id,source AS provider,provider_customer_id
          FROM subscriptions
         WHERE source=ANY($1::text[]) AND provider_customer_id IS NOT NULL
      ) identities
      ORDER BY provider,provider_customer_id,customer_id
    `,[normalized]);
    return result.rows;
}

async function providerIdentityCounts(providers=PROVIDERS) {
    const rows=await providerIdentityRows(providers);
    const byProvider=new Map();
    for(const row of rows){
        const provider=providerName(row.provider);
        const customers=byProvider.get(provider)||new Set();
        if(row.customer_id)customers.add(String(row.customer_id));
        byProvider.set(provider,customers);
    }
    return [...byProvider.entries()]
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([provider,customers])=>({provider,count:customers.size}));
}

async function providerIdentityOwners(provider,providerCustomerId) {
    const id=text(providerCustomerId);
    if(!id)return[];
    const name=providerName(provider);
    const rows=await providerIdentityRows([name]);
    return [...new Set(rows.filter(row=>String(row.provider_customer_id)===id).map(row=>String(row.customer_id)))];
}

async function paypalSubscriptionReferences() {
    const result=await query(`
      SELECT DISTINCT provider_reference_id
      FROM payment_history_transactions
      WHERE provider='paypal'
        AND provider_reference_id IS NOT NULL
        AND metadata->>'referenceType'='SUB'
    `);
    return new Set(result.rows.map(row=>String(row.provider_reference_id||'').trim()).filter(id=>/^I-/i.test(id)));
}

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
        transaction_type=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN payment_history_transactions.transaction_type ELSE EXCLUDED.transaction_type END,
        transaction_status=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN payment_history_transactions.transaction_status
          ELSE COALESCE(EXCLUDED.transaction_status,payment_history_transactions.transaction_status)
        END,
        occurred_at=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN payment_history_transactions.occurred_at ELSE EXCLUDED.occurred_at END,
        currency=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN payment_history_transactions.currency ELSE EXCLUDED.currency END,
        gross_amount_minor=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN payment_history_transactions.gross_amount_minor ELSE EXCLUDED.gross_amount_minor END,
        fee_amount_minor=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN payment_history_transactions.fee_amount_minor ELSE EXCLUDED.fee_amount_minor END,
        net_amount_minor=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN payment_history_transactions.net_amount_minor ELSE EXCLUDED.net_amount_minor END,
        provider_customer_id=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN COALESCE(payment_history_transactions.provider_customer_id,EXCLUDED.provider_customer_id)
          ELSE COALESCE(EXCLUDED.provider_customer_id,payment_history_transactions.provider_customer_id)
        END,
        provider_reference_id=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN COALESCE(payment_history_transactions.provider_reference_id,EXCLUDED.provider_reference_id)
          ELSE COALESCE(EXCLUDED.provider_reference_id,payment_history_transactions.provider_reference_id)
        END,
        provider_source_id=CASE
          WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
           AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
          THEN COALESCE(payment_history_transactions.provider_source_id,EXCLUDED.provider_source_id)
          ELSE COALESCE(EXCLUDED.provider_source_id,payment_history_transactions.provider_source_id)
        END,
        customer_id=COALESCE(payment_history_transactions.customer_id,EXCLUDED.customer_id),
        metadata=COALESCE(payment_history_transactions.metadata,'{}'::jsonb)
          ||COALESCE(EXCLUDED.metadata,'{}'::jsonb)
          ||CASE
              WHEN COALESCE(payment_history_transactions.metadata->>'feeDataAvailable','false')='true'
               AND COALESCE(EXCLUDED.metadata->>'feeDataAvailable','false')<>'true'
              THEN '{"feeDataAvailable":true}'::jsonb ELSE '{}'::jsonb
            END,
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
               s.customer_id,s.source AS provider,s.provider_customer_id,s.updated_at,s.created_at
        FROM subscriptions s
        WHERE s.source IN ('stripe','paypal','plisio')
          AND NULLIF(BTRIM(COALESCE(s.provider_customer_id,'')),'') IS NOT NULL
          AND (
            s.source<>'stripe'
            OR NOT EXISTS (
              SELECT 1 FROM payment_customers x
              WHERE x.provider='stripe'
                AND x.provider_customer_id=s.provider_customer_id
                AND x.customer_id<>s.customer_id
            )
          )
        ORDER BY s.customer_id,s.source,s.updated_at DESC,s.created_at DESC
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
      WHERE (payment_history_transactions.customer_id IS NULL OR payment_history_transactions.customer_id=EXCLUDED.customer_id)
        AND (
          (payment_history_transactions.customer_id IS NULL AND EXCLUDED.customer_id IS NOT NULL)
          OR (payment_history_transactions.provider_reference_id IS NULL AND EXCLUDED.provider_reference_id IS NOT NULL)
          OR COALESCE(payment_history_transactions.metadata->>'providerAuthoritative','false')<>'true'
          OR COALESCE(payment_history_transactions.metadata->>'providerVerified','false')<>'true'
        )
      RETURNING id
    `);
    return result.rowCount;
}

async function repairLinks({limit=5000}={}) {
    const safe=Math.max(1,Math.min(50000,Number(limit)||5000));
    const result=await query(`
      WITH strong_evidence AS (
        SELECT t.id,c.id AS customer_id
          FROM payment_history_transactions t
          JOIN customers c ON c.id::text=COALESCE(t.metadata->>'customerId',t.metadata->>'internal_customer_id')
         WHERE t.customer_id IS NULL
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
        SELECT t.id,s.customer_id
          FROM payment_history_transactions t
          JOIN subscriptions s ON s.source=t.provider
           AND s.provider_subscription_id IN (t.provider_transaction_id,t.provider_reference_id,t.provider_source_id)
         WHERE t.customer_id IS NULL AND s.provider_subscription_id IS NOT NULL
        UNION ALL
        SELECT t.id,lsi.customer_id
          FROM payment_history_transactions t
          JOIN legacy_subscription_imports lsi ON lsi.provider=t.provider
           AND lsi.provider_transaction_id IN (t.provider_transaction_id,t.provider_reference_id,t.provider_source_id)
         WHERE t.customer_id IS NULL AND lsi.customer_id IS NOT NULL
      ),
      strong_summary AS (
        SELECT id,MIN(customer_id::text)::uuid customer_id,COUNT(DISTINCT customer_id) candidate_count
          FROM strong_evidence GROUP BY id
      ),
      weak_evidence AS (
        SELECT t.id,pc.customer_id
          FROM payment_history_transactions t
          JOIN payment_customers pc ON pc.provider=t.provider AND pc.provider_customer_id=t.provider_customer_id
         WHERE t.customer_id IS NULL AND t.provider_customer_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM strong_summary ss WHERE ss.id=t.id)
        UNION ALL
        SELECT t.id,s.customer_id
          FROM payment_history_transactions t
          JOIN subscriptions s ON s.source=t.provider AND s.provider_customer_id=t.provider_customer_id
         WHERE t.customer_id IS NULL AND t.provider_customer_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM strong_summary ss WHERE ss.id=t.id)
      ),
      weak_summary AS (
        SELECT id,MIN(customer_id::text)::uuid customer_id,COUNT(DISTINCT customer_id) candidate_count
          FROM weak_evidence GROUP BY id
      ),
      resolved AS (
        SELECT id,customer_id FROM strong_summary WHERE candidate_count=1
        UNION ALL
        SELECT id,customer_id FROM weak_summary WHERE candidate_count=1
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

async function providerIdentities(customerId) {
    const result=await query(`
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
    `,[customerId]);
    return result.rows;
}

async function customerIncidents(customerId) {
    const result=await query(`SELECT id,provider,provider_case_id,incident_type,incident_status,created_at,resolved_at FROM payment_incidents WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[customerId]);
    return result.rows;
}

async function unlinkedCountForCustomer(customerId) {
    const result=await query(`
      WITH strong_evidence AS (
        SELECT t.id,c.id AS customer_id
          FROM payment_history_transactions t
          JOIN customers c ON c.id::text=COALESCE(t.metadata->>'customerId',t.metadata->>'internal_customer_id')
         WHERE t.customer_id IS NULL
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
        SELECT t.id,s.customer_id
          FROM payment_history_transactions t
          JOIN subscriptions s ON s.source=t.provider
           AND s.provider_subscription_id IN (t.provider_transaction_id,t.provider_reference_id,t.provider_source_id)
         WHERE t.customer_id IS NULL AND s.provider_subscription_id IS NOT NULL
        UNION ALL
        SELECT t.id,lsi.customer_id
          FROM payment_history_transactions t
          JOIN legacy_subscription_imports lsi ON lsi.provider=t.provider
           AND lsi.provider_transaction_id IN (t.provider_transaction_id,t.provider_reference_id,t.provider_source_id)
         WHERE t.customer_id IS NULL AND lsi.customer_id IS NOT NULL
      ),
      strong_summary AS (
        SELECT id,MIN(customer_id::text)::uuid customer_id,COUNT(DISTINCT customer_id) candidate_count
          FROM strong_evidence GROUP BY id
      ),
      weak_evidence AS (
        SELECT t.id,pc.customer_id
          FROM payment_history_transactions t
          JOIN payment_customers pc ON pc.provider=t.provider AND pc.provider_customer_id=t.provider_customer_id
         WHERE t.customer_id IS NULL AND t.provider_customer_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM strong_summary ss WHERE ss.id=t.id)
        UNION ALL
        SELECT t.id,s.customer_id
          FROM payment_history_transactions t
          JOIN subscriptions s ON s.source=t.provider AND s.provider_customer_id=t.provider_customer_id
         WHERE t.customer_id IS NULL AND t.provider_customer_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM strong_summary ss WHERE ss.id=t.id)
      ),
      weak_summary AS (
        SELECT id,MIN(customer_id::text)::uuid customer_id,COUNT(DISTINCT customer_id) candidate_count
          FROM weak_evidence GROUP BY id
      ),
      resolved AS (
        SELECT id,customer_id FROM strong_summary WHERE candidate_count=1
        UNION ALL
        SELECT id,customer_id FROM weak_summary WHERE candidate_count=1
      )
      SELECT COUNT(*)::int AS count FROM resolved WHERE customer_id=$1
    `,[customerId]);
    return Number(result.rows[0]?.count||0);
}

async function customerSnapshot(customerId) {
    const [identities,transactions,incidents,unlinkedCount]=await Promise.all([
      providerIdentities(customerId),
      queryTransactions({customerId},{limit:100,order:'desc'}).then(result=>result.rows),
      customerIncidents(customerId),
      unlinkedCountForCustomer(customerId)
    ]);
    return{identities,transactions,incidents,unlinkedCount};
}

module.exports={
    PROVIDERS,MAX_QUERY_ROWS,providerName,transactionSelect,transactionWhere,queryTransactions,countTransactions,resolveCustomerId,
    missingPlisioFeeTransactions,markPlisioFeeReconcileAttempt,latestPlisioCallbackEvidence,transactionCoverage,exportTransactions,scanTransactionsInRange,scanAllTransactions,transactionsForCustomers,providerIdentityCounts,latestProviderIdentityJoinSql,ensureProviderIdentity,findProviderIdentity,providerIdentityRows,providerIdentityOwners,paypalSubscriptionReferences,recordTransaction,backfillProviderCustomers,
    backfillPlisioTransactions,repairLinks,reconcileLocalEvidence,providerIdentities,customerIncidents,
    unlinkedCountForCustomer,customerSnapshot
};
