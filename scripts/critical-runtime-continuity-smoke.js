'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const registry=require('../src/automation/jobs');
const worker=read('scripts/automation-worker.js');
const deploy=read('scripts/deploy-production.sh');
const compose=read('docker-compose.yml');
const verify=read('scripts/verify-deployment.js');
const billing=read('src/payments/billing-control.js');
const termination=read('src/payments/subscription-termination.js');
const resilient=read('src/jellyfin/resilient-provisioning.js');
const migration=read('src/jellyfin/server-migration.js');

const mustRun=[
  'health','entitlements','free_capacity_backfill','customer_inactivity','customer_deletions',
  'creation_intent_recovery','customer_service_recovery','revenue_integrity','notification_lifecycle',
  'email_outbox','notification_outbox','discord_roles','billing','subscription_discovery',
  'provider_checkout_recovery','provider_operation_recovery','payment_events','plan_changes',
  'activation_cleanup','stremio_managed_accounts','stremio_external_tokens'
];
for(const key of mustRun){
  assert(registry.definition(key),`critical runtime job disappeared: ${key}`);
  assert.strictEqual(typeof registry.definition(key).run,'function',`runtime job lost executable handler: ${key}`);
}
assert(registry.definition('provider_financial_reconciliation'),
  'unified provider-financial reconciliation must remain registered');
assert(worker.includes('for (const jobKey of jobRegistry.names())')&&worker.includes('VALUES($1,TRUE,$2,NOW()) ON CONFLICT(job_key) DO NOTHING'),
  'automation startup must seed newly-added registry jobs so deployments cannot silently omit them');
assert(worker.includes('jobRegistry.run(jobKey)')&&worker.includes('jobRegistry.criticalNames()'),
  'automation scheduler and deployment health must execute/read the same registry');

for(const service of ['app','automation-worker','activity-worker','backup-worker']){
  const needle=`  ${service}:\n    image: \${CAPTAINFIN_IMAGE:-captainfin:current}`;
  assert(compose.includes(needle),`${service} must use the same immutable CAPTAiNFiN release image`);
}
assert(deploy.includes('docker compose run --rm --no-deps app npm run verify:deployment'),
  'production deployment must execute candidate application-level verification before live web cutover');
assert(deploy.indexOf('docker compose run --rm --no-deps app npm run verify:deployment')<deploy.indexOf("log 'Candidate verified; switching the customer-facing web application'"),
  'live web cutover must not happen until candidate deployment verification succeeds');
assert(deploy.indexOf("log 'Candidate verified; switching the customer-facing web application'")<deploy.indexOf('docker image tag "$CAPTAINFIN_IMAGE" captainfin:current'),
  'verified alias must not advance until the verified candidate web runtime has cut over');
assert(verify.includes('jobRegistry.criticalNames()')&&verify.includes("add('automation worker registry'"),
  'deployment verification must fail when the automation worker loses registered critical jobs');

assert(billing.includes('async function setRenewal(')&&billing.includes('terminateRecurringForDeletion'),
  'recurring cancellation/renewal controls must remain in the canonical billing owner');
assert(termination.includes("const OPERATION_TYPE='subscription_terminate'")&&termination.includes('billingControl.terminateRecurringForDeletion'),
  'immediate cancellation must remain a durable provider operation through canonical billing adapters');
assert(termination.includes('providerOps.providerApplied')&&termination.includes('providerOps.localApplied')&&termination.includes('providerOps.reconciled'),
  'cancellation must retain crash-safe provider/local convergence states');

assert(resilient.includes('async function reconcileCustomer(customerId)')&&resilient.includes('withCustomerReconciliationLock'),
  'customer/server provisioning must remain serialized through the resilient reconciler');
assert(migration.includes("require('./reconciliation-lock')")&&migration.includes('withCustomerReconciliationLock'),
  'server migration and rollback must use the shared customer reconciliation lock');
assert(migration.includes('async function executeMigration(')&&migration.includes('async function rollbackMigration('),
  'server migration and rollback workflows must remain available');

console.log('critical runtime continuity smoke: ok');
