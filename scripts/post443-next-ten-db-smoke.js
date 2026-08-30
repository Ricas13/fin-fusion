'use strict';
require('dotenv').config();
const assert = require('assert');
const { query, getPool } = require('../src/db');
const credits = require('../src/affiliate-credits');
const incidents = require('../src/payments/incidents');
const accessHolds = require('../src/entitlements/access-holds');

async function createCustomer(label, suffix) {
  return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`, [label, `${label}-${suffix}@example.invalid`])).rows[0];
}

async function renewalReservationBalance(customer, suffix) {
  const plan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,1000,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`, [`renewal-balance-${suffix}`])).rows[0];
  const sub = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,service_type_snapshot)
    VALUES($1,$2,'active','stripe',$3,NOW(),NOW()+INTERVAL '1 month',1000,'GBP','jellyfin') RETURNING *`, [customer.id, plan.id, `sub_balance_${suffix}`])).rows[0];
  await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note)
    VALUES($1,'GBP',1000,'adjustment','available',$2,'balance smoke credit')`, [customer.id, `post443-credit-${suffix}`]);
  await query(`INSERT INTO affiliate_credit_renewal_reservations(customer_id,subscription_id,provider,provider_invoice_id,currency,amount_minor,state)
    VALUES($1,$2,'stripe',$3,'GBP',400,'provider_applied')`, [customer.id, sub.id, `in_balance_${suffix}`]);

  const balances = await credits.balances(customer.id);
  const gbp = balances.find(row => row.currency === 'GBP');
  assert(gbp, 'GBP service-credit balance must exist');
  assert.equal(gbp.available_minor, 600, 'displayed spendable balance must subtract provider-applied renewal reservations');
}

async function reopenSuspendingIncident(customer, suffix) {
  const caseId = `dp_reopen_${suffix}`;
  const incident = (await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,access_action,metadata,resolved_at)
    VALUES('stripe',$1,$2,'dispute','resolved','direct',$3,'suspend','{}'::jsonb,NOW()) RETURNING *`, [`evt_reopen_${suffix}`, caseId, customer.id])).rows[0];
  assert(!(await accessHolds.activeHolds(customer.id)).some(h => h.hold_type === 'payment_risk' && h.source_key === `stripe:${caseId}`), 'fixture must start without payment-risk hold');

  await incidents.reopen(incident.id, null);
  const holds = await accessHolds.activeHolds(customer.id);
  assert(holds.some(h => h.hold_type === 'payment_risk' && h.source_key === `stripe:${caseId}`), 'reopening a suspending incident must reapply its payment-risk hold');
}

async function main() {
  const suffix = Date.now().toString(36);
  const customer = await createCustomer('post443-next-ten', suffix);
  await renewalReservationBalance(customer, suffix);
  await reopenSuspendingIncident(customer, suffix);
  console.log('post-443 next-ten commercial DB smoke: ok');
}

main().then(() => getPool().end()).catch(async error => {
  console.error(error.stack || error);
  try { await getPool().end(); } catch (_) {}
  process.exit(1);
});
