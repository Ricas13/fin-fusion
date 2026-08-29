'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyLegacy, activePayments, stripePriceMatch } = require('./reconcile-streamsmanager-legacy-pricing');

function payment(planName, processor, amount) {
  return { planName, processor, amount };
}

assert.equal(classifyLegacy(payment('Monthly - 3 Streams', 'stripe', 400)).kind, 'legacy');
assert.equal(classifyLegacy(payment('6 Months - 3 streams', 'stripe', 2000)).kind, 'legacy');
assert.equal(classifyLegacy(payment('Yearly - 3 Streams', 'stripe', 4000)).kind, 'legacy');
assert.equal(classifyLegacy(payment('3 Streams - Monthly', 'stripe', 600)).kind, 'not_legacy');
assert.equal(classifyLegacy(payment('Monthly - 3 Streams', 'paypal', 400)).kind, 'review');
assert.equal(classifyLegacy(payment('Monthly - 3 Streams', 'stripe', 469)).kind, 'review');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-pricing-'));
const file = path.join(dir, 'payments.csv');
fs.writeFileSync(file, [
  'Email,Plan,Transaction ID,Processor,Type,Amount,From,To',
  'old@example.com,Monthly - 3 Streams,pi_old,Stripe,Payment,$4.00,2026-08-01T00:00:00Z,2026-09-01T00:00:00Z',
  'new@example.com,3 Streams - Monthly,pi_new,Stripe,Payment,$6.00,2026-08-01T00:00:00Z,2026-09-01T00:00:00Z',
  'weird@example.com,Monthly - 3 Streams,pi_weird,Stripe,Payment,$4.69,2026-08-01T00:00:00Z,2026-09-01T00:00:00Z',
  'paypal@example.com,Monthly - 3 Streams,pp_old,PayPal,Payment,$4.00,2026-08-01T00:00:00Z,2026-09-01T00:00:00Z'
].join('\n'));
const result = activePayments([file], new Date('2026-08-29T00:00:00Z'));
assert.equal(result.eligible.length, 1);
assert.equal(result.eligible[0].email, 'old@example.com');
assert.equal(result.review.length, 2);

const matchingSub = { status: 'active', items: { data: [{ price: { id: 'price_old', unit_amount: 400, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } };
const wrongSub = { status: 'active', items: { data: [{ price: { id: 'price_new', unit_amount: 600, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } };
const spec = classifyLegacy(payment('Monthly - 3 Streams', 'stripe', 400)).spec;
assert.equal(stripePriceMatch(matchingSub, spec).id, 'price_old');
assert.equal(stripePriceMatch(wrongSub, spec), null);

fs.rmSync(dir, { recursive: true, force: true });
console.log('StreamsManager legacy pricing smoke passed.');
