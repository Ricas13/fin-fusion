'use strict';

// A deliberately read-only reconciliation of remaining purchase value.
// Report UUIDs and financial evidence, never personal or provider secrets.
const {previewFromEvidence,readEvidence}=require('./paid-value-preview');
function options(args){
 const out={limit:500,after:null};
 for(let i=0;i<args.length;i++){
   const key=args[i],value=args[++i];
   if(key==='--limit'&&/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=5000)out.limit=Number(value);
   else if(key==='--after'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))out.after=value;
   else throw new Error('Usage: --limit 1..5000 [--after subscription UUID]');
 }
 return out;
}
async function reconcile(client,{limit,after}){
 const result=await client.query(`
 SELECT s.id,s.customer_id,s.source,s.status,s.billing_mode,
   s.current_period_end+COALESCE(s.service_extension_days,0)*INTERVAL '1 day' AS access_end,
   COALESCE(s.service_extension_days,0) AS extension_days
 FROM subscriptions s JOIN plans p ON p.id=s.plan_id
 WHERE s.superseded_by IS NULL AND s.refund_terminated_at IS NULL
 AND s.status IN ('active','cancelled','expired')
 AND COALESCE(p.is_free_tier,FALSE)=FALSE AND COALESCE(p.is_addon,FALSE)=FALSE
 AND COALESCE(NULLIF(s.billing_interval_snapshot,''),p.billing_interval,'')<>'trial'
 AND s.current_period_end+COALESCE(s.service_extension_days,0)*INTERVAL '1 day'>NOW()
 AND ($1::uuid IS NULL OR s.id>$1)
 ORDER BY s.id LIMIT $2`,[after,limit+1]);
 const records=[],reasons={},totals={};let verified=0,review=0;
 for(const s of result.rows.slice(0,limit)){
   const evidence=previewFromEvidence(await readEvidence(client,s.id));
   if(evidence.verified){
     verified++;
     const n=BigInt(evidence.remainingValueMinor.numerator),d=BigInt(evidence.remainingValueMinor.denominator);
     // Floor each record only for the explicitly labelled conservative aggregate.
     totals[evidence.currency]=(BigInt(totals[evidence.currency]||'0')+n/d).toString();
   }else{review++;reasons[evidence.reason]=(reasons[evidence.reason]||0)+1;}
   records.push({subscriptionId:s.id,provider:s.source,billingMode:s.billing_mode,status:s.status,
     accessEnd:s.access_end,extensionDays:s.extension_days,evidence});
 }
 const hasMore=result.rows.length>limit;
 return {readOnly:true,verified,requiresReview:review,reasons,verifiedRemainingMinorFloorByCurrency:totals,
   nextAfter:hasMore?records.at(-1).subscriptionId:null,records};
}
async function main(){
 const opts=options(process.argv.slice(2));require('dotenv').config();
 const pool=require('../src/db').getPool();let client;
 try{
   client=await pool.connect();
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await client.query("SET LOCAL statement_timeout='30s'");
   const report=await reconcile(client,opts);
   await client.query('COMMIT');
   console.log(JSON.stringify(report,null,2));
 }catch(error){
   if(client)await client.query('ROLLBACK').catch(()=>{});
   throw error;
 }finally{if(client)client.release();await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={options,reconcile};
