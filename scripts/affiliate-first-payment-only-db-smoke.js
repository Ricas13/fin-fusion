'use strict';
require('dotenv').config();
const assert = require('assert');
const { query, getPool } = require('../src/db');
const credits = require('../src/affiliate-credits');
const referrals = require('../src/referrals');

async function customer(label, suffix) {
  return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`, [label,`${label}-${suffix}@example.invalid`])).rows[0];
}
async function plan(code) {
  return (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,1000,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`, [code])).rows[0];
}
async function purchase(customerId, planId, providerId, startsAt) {
  return (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,service_type_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe',$3,$4,$4::timestamptz+INTERVAL '1 month',1000,'GBP','jellyfin',$5::jsonb) RETURNING *`, [customerId,planId,providerId,startsAt,JSON.stringify({discountedMinor:1000,currency:'GBP',checkoutMode:'payment'})])).rows[0];
}

async function main() {
  const suffix = Date.now().toString(36);
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [JSON.stringify({enabled:true,rewardPercent:20,qualificationDelayDays:0,refundWindowDays:0})]);

  const referrer = await customer('affiliate-first-referrer', suffix);
  const friend = await customer('affiliate-first-friend', suffix);
  const testPlan = await plan(`affiliate-first-${suffix}`);
  await credits.enroll(referrer.id);
  const code = (await query('SELECT code FROM referral_codes WHERE customer_id=$1', [referrer.id])).rows[0].code;
  await referrals.attributeReferral(friend.id, code);

  const first = await purchase(friend.id, testPlan.id, `pi_affiliate_first_${suffix}`, new Date(Date.now()-86400000));
  const reward = await referrals.rewardIfQualifying(friend.id);
  assert.equal(reward?.rewarded, true, 'the friend first qualifying paid purchase must create one reward');
  assert.equal(reward?.amountMinor, 200, 'reward must be based on the first £10 provider-paid purchase');

  await purchase(friend.id, testPlan.id, `pi_affiliate_second_${suffix}`, new Date());
  const secondAttempt = await referrals.rewardIfQualifying(friend.id);
  assert.equal(secondAttempt, null, 'later purchases/renewals must not reopen a rewarded referral');

  const earned = await query(`SELECT id,qualifying_subscription_id,amount_minor FROM affiliate_credit_ledger
    WHERE customer_id=$1 AND entry_type='earned' AND referred_customer_id=$2 ORDER BY created_at`, [referrer.id,friend.id]);
  assert.equal(earned.rowCount, 1, 'one referred friend must generate exactly one earned affiliate reward');
  assert.equal(String(earned.rows[0].qualifying_subscription_id), String(first.id), 'the reward must remain attached to the first qualifying purchase');
  assert.equal(Number(earned.rows[0].amount_minor), 200);

  const redemption = (await query('SELECT status FROM referral_redemptions WHERE referred_customer_id=$1', [friend.id])).rows[0];
  assert.equal(redemption.status, 'rewarded', 'rewarded referral redemption must remain terminal for future payments');

  console.log('affiliate first-payment-only DB smoke: ok — one friend, one qualifying reward, no recurring commission');
}

main().then(()=>getPool().end()).catch(async error => { console.error(error.stack || error); try { await getPool().end(); } catch (_) {} process.exit(1); });
