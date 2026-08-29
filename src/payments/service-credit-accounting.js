'use strict';

const planPricing=require('./plan-pricing');

function cleanCurrency(value){return planPricing.cleanCurrency(value,'GBP');}
function int(value){const n=Number(value);return Number.isInteger(n)?n:0;}

async function lockCustomer(client,customerId){
  const row=await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[customerId]);
  if(!row.rowCount)throw new Error('Customer account not found.');
}

async function rawAvailableMinorForClient(client,customerId,currency,{includeReservations=true}={}){
  const wanted=cleanCurrency(currency);
  const r=await client.query(`SELECT
    COALESCE((SELECT SUM(amount_minor) FROM affiliate_credit_ledger WHERE customer_id=$1 AND currency=$2 AND state='available'),0)::int AS ledger,
    COALESCE((SELECT SUM(amount_minor) FROM affiliate_credit_checkout_reservations WHERE customer_id=$1 AND currency=$2 AND state='reserved' AND expires_at>NOW()),0)::int AS reserved`,[customerId,wanted]);
  const available=int(r.rows[0]?.ledger)-(includeReservations?int(r.rows[0]?.reserved):0);
  if(available<0)throw new Error(`Service-credit accounting invariant violated for ${wanted}: calculated available balance is ${available}.`);
  return available;
}

function sourceRewardIdForDebit(row){
  const metadata=row.metadata&&typeof row.metadata==='object'?row.metadata:{};
  return metadata.sourceRewardId||metadata.earnedCreditId||null;
}

async function grantRows(client,{customerId,currency,debitCreatedAt,sourceRewardId=null,allowPending=false}){
  const params=[customerId,currency,debitCreatedAt];
  let source='';
  if(sourceRewardId){params.push(String(sourceRewardId));source=` AND (g.id::text=$4 OR g.metadata->>'sourceRewardId'=$4)`;}
  const states=allowPending?`('available','pending')`:`('available')`;
  const r=await client.query(`SELECT g.id,g.amount_minor,g.created_at,
      COALESCE((SELECT SUM(a.amount_minor) FROM affiliate_credit_allocations a WHERE a.grant_ledger_id=g.id),0)::int allocated_minor
    FROM affiliate_credit_ledger g
    WHERE g.customer_id=$1 AND g.currency=$2 AND g.amount_minor>0 AND g.state IN ${states}
      AND g.created_at<=$3 ${source}
    ORDER BY g.created_at,g.id FOR UPDATE`,params);
  return r.rows;
}

async function allocateOneDebit(client,row){
  const amount=Math.abs(int(row.amount_minor));
  if(amount<=0)return 0;
  const existing=await client.query(`SELECT COALESCE(SUM(amount_minor),0)::int n FROM affiliate_credit_allocations WHERE debit_ledger_id=$1`,[row.id]);
  let remaining=amount-int(existing.rows[0]?.n);
  if(remaining<=0)return 0;
  const sourceRewardId=sourceRewardIdForDebit(row);
  const grants=await grantRows(client,{customerId:row.customer_id,currency:row.currency,debitCreatedAt:row.created_at,sourceRewardId,allowPending:row.entry_type==='reversed'});
  let allocated=0;
  for(const grant of grants){
    const free=Math.max(0,int(grant.amount_minor)-int(grant.allocated_minor));
    const take=Math.min(free,remaining);
    if(take<=0)continue;
    await client.query(`INSERT INTO affiliate_credit_allocations(customer_id,currency,debit_ledger_id,grant_ledger_id,amount_minor)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(debit_ledger_id,grant_ledger_id) DO NOTHING`,[row.customer_id,row.currency,row.id,grant.id,take]);
    remaining-=take;allocated+=take;
    if(remaining===0)break;
  }
  if(remaining>0)throw new Error(`Service-credit source allocation invariant violated: ${remaining} ${row.currency} minor units of debit ${row.id} have no grant source.`);
  return allocated;
}

async function ensureHistoricalAllocations(client,customerId,currency){
  const wanted=cleanCurrency(currency);
  await lockCustomer(client,customerId);
  const debits=await client.query(`SELECT id,customer_id,currency,amount_minor,entry_type,metadata,created_at
    FROM affiliate_credit_ledger
    WHERE customer_id=$1 AND currency=$2 AND amount_minor<0 AND state<>'void'
    ORDER BY created_at,id FOR UPDATE`,[customerId,wanted]);
  for(const row of debits.rows)await allocateOneDebit(client,row);
  return debits.rowCount;
}

async function allocatedFromReward(client,sourceRewardId){
  const r=await client.query(`SELECT COALESCE(SUM(a.amount_minor),0)::int n
    FROM affiliate_credit_allocations a
    JOIN affiliate_credit_ledger g ON g.id=a.grant_ledger_id
    WHERE g.id=$1 OR g.metadata->>'sourceRewardId'=$1::text`,[sourceRewardId]);
  return int(r.rows[0]?.n);
}

async function sourceCapacity(client,sourceRewardId){
  const r=await client.query(`SELECT COALESCE(SUM(amount_minor),0)::int n FROM affiliate_credit_ledger
    WHERE amount_minor>0 AND state<>'void' AND (id=$1 OR metadata->>'sourceRewardId'=$1::text)`,[sourceRewardId]);
  return int(r.rows[0]?.n);
}

async function recoveryForReward(client,sourceRewardId){
  const r=await client.query(`SELECT COALESCE(amount_minor,0)::int amount_minor,COALESCE(recovered_minor,0)::int recovered_minor FROM affiliate_credit_recoveries WHERE source_reward_id=$1 FOR UPDATE`,[sourceRewardId]);
  return{amountMinor:int(r.rows[0]?.amount_minor),recoveredMinor:int(r.rows[0]?.recovered_minor)};
}

async function recordRecovery(client,{customerId,currency,sourceRewardId,amountMinor,reason,metadata={}}){
  const amount=int(amountMinor);if(amount<=0)return 0;
  await client.query(`INSERT INTO affiliate_credit_recoveries(customer_id,currency,source_reward_id,amount_minor,reason,metadata)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT(source_reward_id) DO UPDATE SET amount_minor=affiliate_credit_recoveries.amount_minor+EXCLUDED.amount_minor,
      reason=EXCLUDED.reason,metadata=affiliate_credit_recoveries.metadata||EXCLUDED.metadata,updated_at=NOW()`,[customerId,cleanCurrency(currency),sourceRewardId,amount,String(reason).slice(0,500),JSON.stringify(metadata||{})]);
  return amount;
}

async function recoverableMinorForClient(client,customerId,currency){
  const r=await client.query(`SELECT COALESCE(SUM(amount_minor-recovered_minor),0)::int n FROM affiliate_credit_recoveries WHERE customer_id=$1 AND currency=$2`,[customerId,cleanCurrency(currency)]);
  return int(r.rows[0]?.n);
}

module.exports={cleanCurrency,lockCustomer,rawAvailableMinorForClient,ensureHistoricalAllocations,allocateOneDebit,allocatedFromReward,sourceCapacity,recoveryForReward,recordRecovery,recoverableMinorForClient};
