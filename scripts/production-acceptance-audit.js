'use strict';

require('dotenv').config();
const accessIntegrity=require('../src/access/access-integrity');
const revenueIntegrity=require('../src/automation/revenue-integrity');
const providerRecovery=require('../src/payments/provider-operation-recovery');
const {getPool}=require('../src/db');

function countBy(rows,key){
  const counts={};
  for(const row of rows||[]){
    const value=String(row?.[key]||'unknown');
    counts[value]=(counts[value]||0)+1;
  }
  return counts;
}

function compactProviderOperation(row){
  return{
    id:row.id,
    provider:row.provider,
    ownerId:row.owner_id,
    operationType:row.operation_type,
    state:row.state,
    attempts:Number(row.attempt_count||0),
    failureKind:row.failure_kind||null,
    lastError:String(row.last_error||'').slice(0,500),
    updatedAt:row.updated_at||null
  };
}

async function collect(){
  const [accessFindings,revenueFindings,providerOperations]=await Promise.all([
    accessIntegrity.scan({limit:500}),
    revenueIntegrity.scan(),
    providerRecovery.attention({limit:500})
  ]);
  const manualReview=providerOperations.filter(row=>Boolean(row.manual_review_required));
  return{
    accessIntegrity:{
      count:accessFindings.length,
      byKind:countBy(accessFindings,'kind'),
      findings:accessFindings
    },
    revenueIntegrity:{
      count:revenueFindings.length,
      byKind:countBy(revenueFindings,'kind'),
      findings:revenueFindings
    },
    providerOperations:{
      openCount:providerOperations.length,
      manualReviewCount:manualReview.length,
      byState:countBy(providerOperations,'state'),
      manualReview:manualReview.map(compactProviderOperation)
    }
  };
}

async function main(){
  const report=await collect();
  console.log(JSON.stringify(report,null,2));

  if(report.accessIntegrity.count){
    console.error(`ATTENTION: ${report.accessIntegrity.count} Access Integrity finding(s) remain after the deployment recovery probe.`);
  }else{
    console.log('PASS  Access Integrity — no current findings.');
  }

  if(report.revenueIntegrity.count){
    console.error(`ATTENTION: ${report.revenueIntegrity.count} Revenue Integrity finding(s) remain; review the finding details above before closing production acceptance.`);
  }else{
    console.log('PASS  Revenue Integrity — no current findings.');
  }

  if(report.providerOperations.manualReviewCount){
    console.error(`ATTENTION: ${report.providerOperations.manualReviewCount} provider operation(s) require manual review. They were not retried by this audit.`);
  }else{
    console.log('PASS  Provider operations — no manual-review operations are waiting.');
  }

  if(report.accessIntegrity.count||report.revenueIntegrity.count||report.providerOperations.manualReviewCount){
    process.exitCode=2;
    return;
  }
  console.log('Production acceptance audit passed.');
}

if(require.main===module){
  main().catch(error=>{
    console.error(`Production acceptance audit failed: ${error.message}`);
    process.exitCode=1;
  }).finally(async()=>{try{await getPool().end();}catch(_){}});
}

module.exports={countBy,compactProviderOperation,collect,main};
