'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('provider financial state DB smoke')) process.exit(0);

const assert=require('assert');
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const financialState=require('../src/payments/provider-financial-state');

async function main(){
  const suffix=crypto.randomBytes(8).toString('hex');
  const emails=[`financial-a-${suffix}@example.invalid`,`financial-b-${suffix}@example.invalid`,`financial-s-${suffix}@example.invalid`];
  let customerA=null,customerB=null,customerS=null,plan=null;
  const transactionIds=[`PAYPAL-STRONG-${suffix}`,`PAYPAL-WEAK-${suffix}`,`STRIPE-WEAK-${suffix}`,`PAYPAL-QUALITY-${suffix}`];
  try{
    customerA=(await query(`INSERT INTO customers(display_name,email) VALUES('Financial A',$1) RETURNING id`,[emails[0]])).rows[0];
    customerB=(await query(`INSERT INTO customers(display_name,email) VALUES('Financial B',$1) RETURNING id`,[emails[1]])).rows[0];
    customerS=(await query(`INSERT INTO customers(display_name,email) VALUES('Financial Stripe',$1) RETURNING id`,[emails[2]])).rows[0];
    plan=(await query(`
      INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,active,visible)
      VALUES($1,'Financial identity test','jellyfin','direct','month',30,600,'GBP',TRUE,TRUE)
      RETURNING id
    `,[`financial-identity-${suffix}`])).rows[0];

    const sharedPayer=`PAYER-SHARED-${suffix}`;
    await query(`
      INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_customer_id,provider_subscription_id,billing_mode,starts_at,current_period_end)
      VALUES
        ($1,$3,'active','paypal',$4,$5,'subscription',NOW(),NOW()+INTERVAL '30 days'),
        ($2,$3,'active','paypal',$4,$6,'subscription',NOW(),NOW()+INTERVAL '30 days')
    `,[customerA.id,customerB.id,plan.id,sharedPayer,`I-A-${suffix}`,`I-B-${suffix}`]);

    const payerOwners=await financialState.providerIdentityOwners('paypal',sharedPayer);
    assert.deepStrictEqual(new Set(payerOwners),new Set([String(customerA.id),String(customerB.id)]),
      'PayPal payer IDs must be allowed to fund more than one local customer');

    await query(`
      INSERT INTO payment_history_transactions(
        provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
        gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,provider_reference_id
      ) VALUES
        ('paypal',$1,'T0003','S',NOW(),'GBP',600,20,580,$3,$4),
        ('paypal',$2,'T0003','S',NOW(),'GBP',600,20,580,$3,NULL)
    `,[transactionIds[0],transactionIds[1],sharedPayer,`I-B-${suffix}`]);

    await financialState.repairLinks({limit:100});
    const paypalRows=(await query(`
      SELECT provider_transaction_id,customer_id
      FROM payment_history_transactions
      WHERE provider='paypal' AND provider_transaction_id=ANY($1::text[])
      ORDER BY provider_transaction_id
    `,[transactionIds.slice(0,2)])).rows;
    const strong=paypalRows.find(row=>row.provider_transaction_id===transactionIds[0]);
    const weak=paypalRows.find(row=>row.provider_transaction_id===transactionIds[1]);
    assert.strictEqual(String(strong.customer_id),String(customerB.id),
      'exact PayPal I- subscription evidence must beat ambiguous shared payer identity');
    assert.strictEqual(weak.customer_id,null,
      'shared PayPal payer identity alone must never guess which local customer owns a payment');


    await query(`
      INSERT INTO payment_history_transactions(
        provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
        gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,provider_reference_id,customer_id,metadata
      ) VALUES('paypal',$1,'T0003','S','2026-09-01T12:00:00Z','GBP',600,25,575,$2,$3,$4,
        '{"providerAuthoritative":true,"feeDataAvailable":true,"referenceType":"SUB"}'::jsonb)
    `,[transactionIds[3],sharedPayer,`I-B-${suffix}`,customerB.id]);
    await financialState.recordTransaction({
      provider:'paypal',
      providerTransactionId:transactionIds[3],
      transactionType:'paypal_sale',
      transactionStatus:'COMPLETED',
      occurredAt:'2026-09-01T12:05:00Z',
      currency:'GBP',
      grossMinor:650,
      feeMinor:0,
      netMinor:650,
      providerCustomerId:sharedPayer,
      providerReferenceId:`I-B-${suffix}`,
      customerId:customerB.id,
      metadata:{providerAuthoritative:true,feeDataAvailable:false,livePaypalWebhook:true}
    });
    const quality=(await query(`
      SELECT transaction_type,transaction_status,occurred_at,gross_amount_minor,fee_amount_minor,net_amount_minor,metadata
      FROM payment_history_transactions WHERE provider='paypal' AND provider_transaction_id=$1
    `,[transactionIds[3]])).rows[0];
    assert.strictEqual(quality.transaction_type,'T0003','weaker live webhook data must not replace exact provider transaction classification');
    assert.strictEqual(quality.transaction_status,'S','weaker live webhook data must not replace exact provider accounting status');
    assert.strictEqual(Number(quality.gross_amount_minor),600,'weaker live webhook data must not replace exact gross accounting');
    assert.strictEqual(Number(quality.fee_amount_minor),25,'weaker live webhook data must not erase exact provider fees');
    assert.strictEqual(Number(quality.net_amount_minor),575,'weaker live webhook data must not erase exact provider net proceeds');
    assert.strictEqual(quality.metadata.feeDataAvailable,true,'strong fee-data provenance must survive later weaker webhook convergence');

    const stripeCustomer=`cus_financial_${suffix}`;
    await query(`
      INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_customer_id,provider_subscription_id,billing_mode,starts_at,current_period_end)
      VALUES($1,$2,'active','stripe',$3,$4,'subscription',NOW(),NOW()+INTERVAL '30 days')
    `,[customerS.id,plan.id,stripeCustomer,`sub_financial_${suffix}`]);
    await query(`
      INSERT INTO payment_history_transactions(
        provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
        gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id
      ) VALUES('stripe',$1,'charge','available',NOW(),'GBP',600,20,580,$2)
    `,[transactionIds[2],stripeCustomer]);

    await financialState.repairLinks({limit:100});
    const stripeRow=(await query(`
      SELECT customer_id FROM payment_history_transactions
      WHERE provider='stripe' AND provider_transaction_id=$1
    `,[transactionIds[2]])).rows[0];
    assert.strictEqual(String(stripeRow.customer_id),String(customerS.id),
      'unique Stripe cus_ identity must repair an unowned transaction');

    await assert.rejects(
      query(`INSERT INTO payment_customers(customer_id,provider,provider_customer_id) VALUES($1,'stripe',$2)`,[customerA.id,stripeCustomer]),
      /duplicate|unique/i,
      'Stripe customer identity must remain one-to-one'
    );

    console.log('provider financial state DB smoke: ok (PayPal fan-in, exact ownership, Stripe uniqueness)');
  } finally {
    await query(`DELETE FROM payment_history_transactions WHERE provider_transaction_id=ANY($1::text[])`,[transactionIds]).catch(()=>{});
    const ids=[customerA?.id,customerB?.id,customerS?.id].filter(Boolean);
    if(ids.length){
      await query(`DELETE FROM subscriptions WHERE customer_id=ANY($1::uuid[])`,[ids]).catch(()=>{});
      await query(`DELETE FROM payment_customers WHERE customer_id=ANY($1::uuid[])`,[ids]).catch(()=>{});
      await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`,[ids]).catch(()=>{});
    }
    if(plan?.id)await query('DELETE FROM plans WHERE id=$1',[plan.id]).catch(()=>{});
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>getPool().end());
