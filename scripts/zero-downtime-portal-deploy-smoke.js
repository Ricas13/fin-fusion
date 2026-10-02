'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');

const deploy=fs.readFileSync(path.join(root,'scripts','deploy-production.sh'),'utf8');
const runtime=fs.readFileSync(path.join(root,'scripts','lib','compose-runtime.sh'),'utf8');
const workflow=fs.readFileSync(path.join(root,'.github','workflows','merge-safety.yml'),'utf8');

for(const token of [
  "Starting isolated candidate portal while the current portal continues serving",
  "Attaching verified candidate alongside the current portal for zero-downtime handoff",
  "Verified overlap candidate keeps customer traffic live during canonical replacement",
  "Attaching replacement portal before retiring overlap candidate",
  "Replacement verified; retiring overlap candidate",
  "compose_capture_runtime_labels",
  "connect_missing_container_networks",
  "verify_portal_routes_in_container"
]) assert(deploy.includes(token)||runtime.includes(token),`zero-downtime deployment contract missing: ${token}`);

const candidateStart=deploy.indexOf("Starting isolated candidate portal while the current portal continues serving");
const candidateAttach=deploy.indexOf("Attaching verified candidate alongside the current portal for zero-downtime handoff");
const canonicalReplace=deploy.indexOf("Candidate verified; switching the customer-facing web application");
const replacementAttach=deploy.indexOf("Attaching replacement portal before retiring overlap candidate");
const liveVerify=deploy.indexOf("Running live post-cutover deployment verification");
const retire=deploy.indexOf("Replacement verified; retiring overlap candidate");

assert(candidateStart>=0&&candidateAttach>candidateStart,'candidate must become ready before production attachment');
assert(canonicalReplace>candidateAttach,'canonical replacement must occur only after candidate overlap begins');
const rollbackArm=deploy.indexOf('app_recreated=1',canonicalReplace);
const canonicalComposeUp=deploy.indexOf('docker compose',canonicalReplace);
assert(rollbackArm>canonicalReplace&&canonicalComposeUp>rollbackArm,
  'canonical app rollback must be armed before Compose can partially replace the serving container');
assert(replacementAttach>canonicalReplace,'replacement must be attached while overlap candidate is still serving');
assert(liveVerify>replacementAttach,'live verification must run after replacement attachment');
assert(retire>liveVerify,'overlap candidate must remain serving through live post-cutover verification');

assert(!deploy.includes("docker compose stop --timeout 45 app "),'deployment must never deliberately stop the live portal');
assert(runtime.includes("filter(([key])=>!String(key).startsWith(\"com.docker.compose.\"))"),
  'runtime metadata capture must preserve environment-specific labels without copying Compose internals');
assert(runtime.includes('docker network connect "$network" "$target"'),
  'verified candidate/replacement must inherit live network attachments');

assert(workflow.includes('curl -fsS http://127.0.0.1:3030/health/ready'));
assert(workflow.includes('curl -fsS http://127.0.0.1:3031/health/ready'));
assert(workflow.includes('kill -0 "$(cat /tmp/captainfin-base-app.pid)"'),
  'Merge Safety must prove previous and candidate generations are alive simultaneously');
assert(workflow.indexOf('kill -0 "$(cat /tmp/captainfin-base-app.pid)"')
  < workflow.indexOf('kill "$(cat /tmp/captainfin-base-app.pid)"'),
  'previous generation may be retired only after overlap proof');

console.log('zero-downtime portal deployment contract: ok');
