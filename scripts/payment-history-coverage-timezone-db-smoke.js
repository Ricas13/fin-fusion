'use strict';
const assert=require('assert');
const crypto=require('crypto');
const ledger=require('../src/payments/dashboard-ledger');
const {runDbSmoke,withRollback,withTimezones}=require('./test-fixture');

runDbSmoke('payment history coverage timezone DB smoke',async()=>{
  await withTimezones(['UTC','Europe/London','America/New_York','Asia/Kolkata'],async zone=>{
    await withRollback(async client=>{
      const suffix=crypto.randomBytes(8).toString('hex');
      await client.query(`INSERT INTO payment_history_import_runs(provider_scope,range_start,range_end,status,completed_at)
        VALUES('stripe','2001-07-15','2001-07-15','completed','2001-07-16T00:00:00Z')`);
      await client.query(`INSERT INTO payment_history_transactions(provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor)
        VALUES('stripe',$1,'charge','succeeded','2001-07-15T12:00:00Z','GBP',1000),
              ('stripe',$2,'refund','succeeded','2001-07-15T13:00:00Z','GBP',-200)`,[`ch_${suffix}`,`re_${suffix}`]);
      await client.query(`INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processed_at,created_at)
        VALUES('stripe',$1,'checkout.session.completed',$2::jsonb,NOW(),'2001-07-15T12:00:00Z')`,
      [`evt_${suffix}`,JSON.stringify({data:{object:{mode:'payment',payment_status:'paid',amount_total:1000,currency:'gbp'}}})]);

      const records=[];
      const start=new Date('2001-07-15T00:00:00Z');
      const end=new Date('2001-07-16T00:00:00Z');
      await ledger.scanAccountingRecords({start,previousStart:start,end},row=>records.push(row),{queryFn:client.query.bind(client)});
      const own=records.filter(row=>row.providerEventId.endsWith(suffix));
      assert.equal(own.length,2,`${zone}: imported payment and refund must replace the matching live webhook`);
      assert(own.every(row=>row.source==='history'),`${zone}: completed DATE coverage must remain the requested UTC day`);
      assert.equal(own.reduce((sum,row)=>sum+(row.kind==='refund'?-row.minor:row.minor),0),800);
    });
  });
});
