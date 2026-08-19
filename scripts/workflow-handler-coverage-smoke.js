'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const bulk=require('../src/platform/admin-bulk-customers');
const bulkJobs=read('src/platform/bulk-jobs.js');
const bulkUi=read('src/platform/admin-bulk-customers.js');
const bulkSources=[
  read('src/platform/bulk-operations.js'),
  read('src/platform/operator-bulk-operations.js'),
  read('src/jellyfin/bulk-worker.js')
].join('\n');

const missingBulk=[];
for(const [key,,meta] of bulk.BULK_ACTIONS){
  if(meta?.immediate)continue;
  const pattern=new RegExp(`registerHandler\\(['"]${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}['"]`);
  if(!pattern.test(bulkSources))missingBulk.push(key);
}
assert.deepEqual(missingBulk,[],'Every queued customer bulk action must have a registered worker handler');
assert(bulkJobs.includes('pg_advisory_xact_lock')&&!bulkJobs.includes('ON CONFLICT (created_by,idempotency_key)'),'Bulk job idempotency must not depend on fragile partial-index conflict inference');
assert(bulkUi.includes('Bulk action could not be started: ${String(error.message||error).slice(0,500)}'),'Admin bulk failures must expose the specific server-side reason');

const automation=require('../src/automation/jobs');
const jobSource=read('src/automation/jobs.js');
const workerSource=read('scripts/automation-worker.js');
const migrationDir=path.join(root,'db','migrations');
const migrationSql=fs.readdirSync(migrationDir)
  .filter(file=>file.endsWith('.sql'))
  .sort()
  .map(file=>fs.readFileSync(path.join(migrationDir,file),'utf8'))
  .join('\n');
const automationStatements=migrationSql.split(';').filter(statement=>/automation_job_state/i.test(statement));
const registered=[...new Set(automationStatements.flatMap(statement=>[
  ...[...statement.matchAll(/(?:INSERT\s+INTO\s+(?:public\.)?automation_job_state(?:\s*\([^)]*\))?\s+VALUES\s*\(|VALUES\s*\()\s*'([^']+)'/gi)].map(match=>match[1]),
  ...[...statement.matchAll(/job_key\s*=\s*'([^']+)'/gi)].map(match=>match[1])
]))];
const coded=automation.names();
const missingSeedCode=registered.filter(name=>!coded.includes(name));
const missingCodeSeed=coded.filter(name=>!registered.includes(name));
assert.deepEqual(missingSeedCode,[],'Every seeded automation job must have implementation code');
if(missingCodeSeed.length){
  assert(/for\s*\(\s*const\s+jobKey\s+of\s+jobRegistry\.names\(\)\s*\)/.test(workerSource),'Automation worker must register coded jobs that are not present in migrations');
}
assert(jobSource.includes("require('../platform/bulk-operations')")&&jobSource.includes("require('../platform/operator-bulk-operations')"),'Automation worker must register both standard and high-impact bulk operation handlers');

console.log(`workflow handler coverage smoke: ok (${bulk.BULK_ACTIONS.length} bulk actions, ${coded.length} automation jobs, ${missingCodeSeed.length} runtime-registered)`);
