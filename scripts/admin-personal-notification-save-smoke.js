'use strict';

// Test classification: static/source-contract.
// This protects a PostgreSQL binding shape but does not prove that the handler
// is mounted or that a real HTTP save succeeds. Mounted proof lives in
// tests/admin-mounted-mutations-journey.js.
const assert=require('assert');
const fs=require('fs');
const path=require('path');

const source=fs.readFileSync(path.join(__dirname,'..','src','platform','admin-personal-notification-preferences-v2.js'),'utf8');
const good="VALUES($1,'admin.notifications.personal.update','app_user',$2,$3::jsonb)";
const broken="VALUES($1,'admin.notifications.personal.update','app_user',$1,$2::jsonb)";

assert(source.includes(good),'Personal notification audit logging must bind actor_user_id and entity_id through separate PostgreSQL parameters.');
assert(!source.includes(broken),'Personal notification audit logging must not reuse one parameter across UUID actor_user_id and text entity_id.');
assert(source.includes('[req.session.authUserId,String(req.session.authUserId),JSON.stringify({eventCount:events.length})]'),'Personal notification audit logging must provide an explicit text entity ID alongside the UUID actor ID.');

console.log('admin personal notification source contract: ok');
