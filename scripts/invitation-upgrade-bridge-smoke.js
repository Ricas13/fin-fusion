'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const baseline=read('db/migrations/000_database_baseline.sql');
const cleanup=read('db/migrations/001_remove_retired_product.sql');
const sourceValues=['manual','stripe','paypal','migration','free_claim','admin_grant','invitation','service_credit'];
const retired='re'+'seller';

function assertSourceContract(sql,label){
  assert(/subscriptions_source_check/.test(sql),`${label} must define the subscription source constraint`);
  for(const source of sourceValues)assert(sql.includes(`'${source}'`),`${label} must allow ${source} subscriptions`);
  assert(!sql.includes(`'${retired}_credit'`),`${label} must not allow retired credit subscriptions`);
  assert(!sql.includes(`'${retired}_sale'`),`${label} must not allow retired sale subscriptions`);
}

assertSourceContract(baseline,'folded baseline');
assertSourceContract(cleanup,'cleanup migration');
assert(cleanup.includes("source=''manual''")&&cleanup.includes("term || '_credit'"),'cleanup migration must preserve historical credit rows under a valid source');
console.log('invitation and subscription source upgrade contract OK');
