'use strict';

// One-shot, read-only monitor intended to run outside the automation worker.
// An alive heartbeat is not proof that scheduled jobs are making progress.
const HEARTBEAT_MAX_MS=90_000;
const {stuckAfterSeconds}=require('../src/automation/job-health');
const WARMUP_MS=5*60_000;

function time(value){
  if(value===null||value===undefined)return null;
  const t=new Date(value).getTime();
  return Number.isFinite(t)?t:null;
}
function evaluate({worker,jobs,definitions,now=Date.now()}){
  const findings=[];
  const add=(severity,code,jobKey=null)=>findings.push({severity,code,jobKey});
  const beat=time(worker?.last_heartbeat_at),started=time(worker?.started_at);
  const workerFresh=beat!==null&&now-beat<=HEARTBEAT_MAX_MS;
  const warmup=workerFresh&&started!==null&&now-started<WARMUP_MS;
  if(!workerFresh)add('critical','automation_heartbeat_missing_or_stale');
  const byKey=new Map((jobs||[]).map(row=>[row.job_key,row]));
  for(const definition of definitions){
    const {key,critical,mayBeDisabled}=definition;
    const row=byKey.get(key);
    if(!row){if(critical&&!warmup)add('critical','critical_job_missing',key);continue;}
    if(row.enabled===false){
      if(critical&&!mayBeDisabled)add('critical','critical_job_disabled',key);
      continue;
    }
    const interval=Math.max(30,Number(row.interval_seconds)||300);
    const began=time(row.last_started_at),completed=time(row.last_completed_at)||time(row.last_success_at);
    const running=began!==null&&(completed===null||began>completed);
    const maxRun=stuckAfterSeconds(row);
    if(running){
      if(now-began>maxRun*1000)add(critical?'critical':'warning','job_running_too_long',key);
      continue;
    }
    if(!critical)continue;
    if(row.last_outcome==='failed'||row.last_error)add('critical','critical_job_failed',key);
    else if(row.last_outcome==='degraded')add('warning','critical_job_degraded',key);
    if(warmup)continue;
    const due=time(row.next_run_at);
    const overdue=due!==null&&now-due>Math.max(interval*2,300)*1000;
    const stale=completed!==null&&now-completed>Math.max(interval*3,900)*1000;
    if(overdue||stale)add('critical','critical_job_overdue',key);
    else if(began===null&&completed===null&&due===null)add('critical','critical_job_never_scheduled',key);
  }
  return {ok:!findings.some(f=>f.severity==='critical'),checkedAt:new Date(now).toISOString(),workerFresh,findings};
}

async function snapshot(pool){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='5s'");
    const now=Number((await client.query('SELECT (EXTRACT(EPOCH FROM NOW())*1000)::bigint AS ms')).rows[0].ms);
    const worker=(await client.query(`SELECT started_at,last_heartbeat_at FROM operational_worker_state
      WHERE worker_key='automation' AND draining_at IS NULL ORDER BY last_heartbeat_at DESC LIMIT 1`)).rows[0]||null;
    const jobs=(await client.query(`SELECT job_key,enabled,interval_seconds,last_started_at,last_completed_at,last_success_at,
      last_outcome,(last_error IS NOT NULL) AS last_error,next_run_at FROM automation_job_state`)).rows;
    await client.query('COMMIT');
    return {worker,jobs,now};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}

async function main(){
  const {getPool}=require('../src/db');
  const registry=require('../src/automation/jobs');
  const pool=getPool();
  try{
    const definitions=registry.names().map(key=>({
      key,critical:registry.isCritical(key),mayBeDisabled:registry.mayBeDisabled(key),
      maxRunSeconds:registry.definition(key)?.maxRunSeconds
    }));
    const result=evaluate({...await snapshot(pool),definitions});
    console.log(JSON.stringify(result));
    return result.ok?0:2;
  }catch(_error){
    // Do not print database errors, customer identifiers, credentials or query text.
    console.log(JSON.stringify({ok:false,findings:[{severity:'critical',code:'watchdog_snapshot_unavailable'}]}));
    return 3;
  }finally{await pool.end().catch(()=>{});}
}

if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{
  console.log(JSON.stringify({ok:false,findings:[{severity:'critical',code:'watchdog_startup_failed'}]}));process.exitCode=3;
});
module.exports={evaluate,snapshot};
