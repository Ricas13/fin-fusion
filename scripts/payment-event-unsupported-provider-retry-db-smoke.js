'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const retry=require('../src/payments/payment-event-retry');

async function main(){
  const eventId=`manual-retry-${crypto.randomBytes(8).toString('hex')}`;
  try{
    const inserted=await query(`
      INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processing_error,processing_started_at,processing_token)
      VALUES('manual',$1,'operator.import','{}'::jsonb,'operator review required',NOW()-INTERVAL '30 minutes',NULL)
      RETURNING id,processing_started_at,processing_error
    `,[eventId]);
    const before=inserted.rows[0];

    await retry.run({limit:100});

    const after=(await query(`
      SELECT processed_at,processing_error,processing_started_at,processing_token
      FROM payment_events WHERE provider='manual' AND provider_event_id=$1
    `,[eventId])).rows[0];
    assert(after,'manual payment-event fixture must remain present');
    assert.strictEqual(after.processed_at,null,'unsupported/manual payment event must remain operator-visible');
    assert.strictEqual(after.processing_token,null,'unsupported/manual payment event must never be leased by provider retry automation');
    assert.strictEqual(after.processing_error,before.processing_error,'provider retry automation must not rewrite operator-visible failure detail');
    assert.strictEqual(new Date(after.processing_started_at).getTime(),new Date(before.processing_started_at).getTime(),'unsupported/manual retry timestamp must not be churned by automation');
    console.log('unsupported payment-event retry DB smoke: OK');
  }finally{
    await query(`DELETE FROM payment_events WHERE provider='manual' AND provider_event_id=$1`,[eventId]).catch(()=>{});
    await getPool().end();
  }
}

main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
