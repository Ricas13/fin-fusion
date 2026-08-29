'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const { query, transaction, closePool } = require('../src/db');
const providerSettings = require('../src/payments/provider-settings');

const LIVE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused', 'unpaid']);
const LEGACY = Object.freeze({
  'monthly - 3 streams': { key: 'month', interval: 'month', amount: 400, currentAmount: 600, code: 'legacy_3_streams_monthly_4', name: 'Legacy Monthly - 3 Streams', stripeInterval: 'month', stripeCount: 1 },
  '6 months - 3 streams': { key: '6_months', interval: '6_months', amount: 2000, currentAmount: 3000, code: 'legacy_3_streams_6_months_20', name: 'Legacy 6 Months - 3 Streams', stripeInterval: 'month', stripeCount: 6 },
  'yearly - 3 streams': { key: 'year', interval: 'year', amount: 4000, currentAmount: 5000, code: 'legacy_3_streams_yearly_40', name: 'Legacy Yearly - 3 Streams', stripeInterval: 'year', stripeCount: 1 }
});

function clean(v) { return String(v == null ? '' : v).trim(); }
function emailKey(v) { return clean(v).toLowerCase(); }
function headerKey(v) { return clean(v).replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function planKey(v) { return clean(v).toLowerCase().replace(/\s+/g, ' '); }
function quoteIdent(v) { return `"${String(v).replace(/"/g, '""')}"`; }

function parseCsv(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const rows = [], row = [];
  let field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row.splice(0)); field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(headerKey);
  return rows.filter(values => values.some(v => clean(v))).map(values => {
    const out = {};
    headers.forEach((h, i) => { if (h) out[h] = values[i] == null ? '' : values[i]; });
    return out;
  });
}

function parseDate(v) {
  const raw = clean(v);
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseUsdMinor(v) {
  const raw = clean(v).replace(/,/g, '');
  if (!raw.includes('$')) return null;
  const m = raw.match(/-?\d+(?:\.\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function normalizePayment(row, file) {
  return {
    file,
    email: emailKey(row.email),
    planName: clean(row.plan),
    processor: clean(row.processor).toLowerCase(),
    transactionId: clean(row['transaction id']),
    type: clean(row.type).toLowerCase(),
    amount: parseUsdMinor(row.amount),
    from: parseDate(row.from),
    to: parseDate(row.to)
  };
}

function classifyLegacy(payment) {
  const spec = LEGACY[planKey(payment.planName)];
  if (!spec) return { kind: 'not_legacy' };
  if (payment.processor !== 'stripe') return { kind: 'review', reason: 'legacy plan name is not Stripe' };
  if (payment.amount !== spec.amount) return { kind: 'review', reason: `legacy plan amount is ${payment.amount == null ? 'unreadable' : payment.amount}, expected ${spec.amount}` };
  return { kind: 'legacy', spec };
}

function activePayments(files, asOf = new Date()) {
  const dedup = new Map();
  for (const file of files) {
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    for (const row of rows) {
      if (!('transaction id' in row) || !('processor' in row) || !('amount' in row) || !('from' in row) || !('to' in row)) continue;
      const p = normalizePayment(row, path.basename(file));
      if (!p.email || !p.transactionId) continue;
      const key = `${p.processor}:${p.transactionId}`;
      if (!dedup.has(key)) dedup.set(key, p);
    }
  }
  const byEmail = new Map();
  for (const p of dedup.values()) {
    if (p.type && p.type !== 'payment') continue;
    if (!p.from || !p.to || p.from > asOf || p.to <= asOf) continue;
    if (!byEmail.has(p.email)) byEmail.set(p.email, []);
    byEmail.get(p.email).push(p);
  }
  const eligible = [], review = [];
  for (const [email, rows] of byEmail) {
    rows.sort((a, b) => b.from - a.from || b.to - a.to);
    if (rows.length > 1) {
      const signatures = new Set(rows.map(r => `${r.processor}|${planKey(r.planName)}|${r.amount}|${r.from.toISOString()}|${r.to.toISOString()}`));
      if (signatures.size > 1) { review.push({ email, reason: 'multiple distinct current payment terms overlap', rows }); continue; }
    }
    const p = rows[0];
    const classified = classifyLegacy(p);
    if (classified.kind === 'legacy') eligible.push({ ...p, spec: classified.spec });
    else if (classified.kind === 'review') review.push({ email, reason: classified.reason, rows: [p] });
  }
  return { eligible, review, dedupedPayments: dedup.size, activeEmails: byEmail.size };
}

async function sourcePlan(spec) {
  const r = await query(`
    SELECT * FROM plans
     WHERE active=TRUE AND visible=TRUE AND archived_at IS NULL
       AND COALESCE(is_addon,FALSE)=FALSE AND COALESCE(is_free_tier,FALSE)=FALSE
       AND audience IN ('direct','both') AND streams=3
       AND billing_interval=$1 AND price_minor=$2 AND UPPER(currency)='USD'
       AND service_type IN ('jellyfin','bundle')
     ORDER BY sort_order,id`, [spec.interval, spec.currentAmount]);
  if (r.rowCount !== 1) throw new Error(`Expected exactly one current ${spec.interval} 3-stream USD plan at ${spec.currentAmount}; found ${r.rowCount}.`);
  return r.rows[0];
}

async function ensureLegacyPlan(client, spec, source) {
  let existing = await client.query('SELECT * FROM plans WHERE code=$1 LIMIT 1', [spec.code]);
  if (!existing.rowCount) {
    const clone = { ...source };
    delete clone.id; delete clone.created_at; delete clone.updated_at;
    Object.assign(clone, { code: spec.code, name: spec.name, price_minor: spec.amount, currency: 'USD', active: true, visible: false, archived_at: null, is_free_tier: false, is_addon: false });
    if ('effective_from' in clone) clone.effective_from = null;
    if ('effective_until' in clone) clone.effective_until = null;
    if ('sort_order' in clone) clone.sort_order = Math.max(Number(source.sort_order || 100) + 1000, 1000);
    const cols = Object.keys(clone);
    const params = cols.map((_, i) => `$${i + 1}`).join(',');
    existing = await client.query(`INSERT INTO plans (${cols.map(quoteIdent).join(',')}) VALUES (${params}) RETURNING *`, cols.map(c => clone[c]));
  } else {
    existing = await client.query(`UPDATE plans SET name=$2,price_minor=$3,currency='USD',active=TRUE,visible=FALSE,archived_at=NULL,is_free_tier=FALSE,is_addon=FALSE,updated_at=NOW() WHERE id=$1 RETURNING *`, [existing.rows[0].id, spec.name, spec.amount]);
  }
  const plan = existing.rows[0];
  const pr = await client.query(`
    INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default)
    VALUES($1,'USD',$2,TRUE,TRUE)
    ON CONFLICT(plan_id,currency) DO UPDATE SET price_minor=EXCLUDED.price_minor,active=TRUE,is_default=TRUE,updated_at=NOW()
    RETURNING id`, [plan.id, spec.amount]);
  return { plan, planPriceId: pr.rows[0].id };
}

async function localTarget(email, spec) {
  const customers = await query(`SELECT c.id FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE lower(COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')))=$1`, [email]);
  if (customers.rowCount !== 1) return { error: `customer matches=${customers.rowCount}` };
  const customerId = customers.rows[0].id;
  const subs = await query(`
    SELECT s.*,p.code current_plan_code,p.name current_plan_name,p.billing_interval,p.streams,p.service_type,p.is_addon
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
     WHERE s.customer_id=$1 AND s.superseded_by IS NULL AND s.current_period_end>NOW()
       AND s.source='stripe' AND COALESCE(p.is_addon,FALSE)=FALSE
       AND p.billing_interval=$2 AND p.streams=3
     ORDER BY CASE WHEN s.provider_subscription_id LIKE 'sub_%' THEN 0 ELSE 1 END,s.starts_at DESC`, [customerId, spec.interval]);
  if (subs.rowCount !== 1) return { error: `matching live Stripe subscriptions=${subs.rowCount}`, customerId };
  return { customerId, subscription: subs.rows[0] };
}

function stripeKey(config) { return config && (config.restrictedKey || config.apiKey) || ''; }
async function stripeClient() {
  const cfg = await providerSettings.get('stripe');
  const key = stripeKey(cfg);
  return key ? new Stripe(key, { apiVersion: '2026-06-24.dahlia', maxNetworkRetries: 2, timeout: 20000 }) : null;
}

function stripePriceMatch(sub, spec) {
  if (!sub || !LIVE_STRIPE_STATUSES.has(String(sub.status || '').toLowerCase())) return null;
  const matches = (sub.items && sub.items.data || []).filter(item => {
    const p = item.price || {};
    const rec = p.recurring || {};
    return Number(p.unit_amount) === spec.amount && String(p.currency || '').toLowerCase() === 'usd' && rec.interval === spec.stripeInterval && Number(rec.interval_count || 1) === spec.stripeCount;
  });
  return matches.length === 1 ? matches[0].price : null;
}

async function resolveRemote(stripe, email, local, spec) {
  if (!stripe) return { state: 'stripe_unavailable' };
  if (String(local.provider_subscription_id || '').startsWith('sub_')) {
    try {
      const sub = await stripe.subscriptions.retrieve(local.provider_subscription_id, { expand: ['items.data.price'] });
      const price = stripePriceMatch(sub, spec);
      return price ? { state: 'verified', subscription: sub, price } : { state: 'mismatch', reason: 'linked Stripe subscription does not have the expected legacy amount/interval' };
    } catch (e) { return { state: 'error', reason: e.message }; }
  }
  let customerIds = [];
  if (local.provider_customer_id) customerIds = [local.provider_customer_id];
  else {
    try { customerIds = (await stripe.customers.list({ email, limit: 100 })).data.filter(c => !c.deleted).map(c => c.id); }
    catch (e) { return { state: 'error', reason: e.message }; }
  }
  const candidates = [];
  for (const customerId of customerIds) {
    try {
      const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, expand: ['data.items.data.price'] });
      for (const sub of page.data) { const price = stripePriceMatch(sub, spec); if (price) candidates.push({ sub, price, customerId }); }
    } catch (e) { return { state: 'error', reason: e.message }; }
  }
  return candidates.length === 1 ? { state: 'verified', subscription: candidates[0].sub, price: candidates[0].price, customerId: candidates[0].customerId } : { state: 'unresolved', reason: `matching current Stripe subscriptions=${candidates.length}` };
}

async function applyOne(item, target, remote, legacyPlans) {
  const legacy = legacyPlans[item.spec.key];
  return transaction(async client => {
    const locked = await client.query('SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [target.subscription.id]);
    if (locked.rowCount !== 1) throw new Error('Subscription disappeared during reconciliation.');
    const current = locked.rows[0];
    const providerSubId = remote.state === 'verified' ? remote.subscription.id : current.provider_subscription_id;
    const providerCustomerId = remote.state === 'verified' ? (typeof remote.subscription.customer === 'string' ? remote.subscription.customer : remote.subscription.customer?.id) : current.provider_customer_id;
    const providerPriceId = remote.state === 'verified' ? remote.price.id : current.provider_price_id_snapshot;
    await client.query(`UPDATE subscriptions SET plan_id=$2,plan_name_snapshot=$3,plan_code_snapshot=$4,price_minor_snapshot=$5,currency_snapshot='USD',billing_interval_snapshot=$6,duration_days_snapshot=$7,service_type_snapshot=$8,provider_subscription_id=$9,provider_customer_id=$10,provider_price_id_snapshot=$11,provider_mapping_external_id_snapshot=COALESCE($11,provider_mapping_external_id_snapshot),updated_at=NOW() WHERE id=$1`, [current.id, legacy.plan.id, legacy.plan.name, legacy.plan.code, item.spec.amount, legacy.plan.billing_interval, legacy.plan.duration_days, legacy.plan.service_type, providerSubId, providerCustomerId, providerPriceId]);
    if (remote.state === 'verified') {
      const conflict = await client.query('SELECT id,plan_id,active FROM plan_provider_prices WHERE provider=\'stripe\' AND external_id=$1 FOR UPDATE', [remote.price.id]);
      if (conflict.rowCount) {
        await client.query(`UPDATE plan_provider_prices SET plan_id=$2,plan_price_id=$3,checkout_mode='subscription',active=FALSE,metadata=COALESCE(metadata,'{}'::jsonb)||'{"legacyStreamsManager":true}'::jsonb,verified_at=NOW(),verification_status='verified',remote_amount_minor=$4,remote_currency='USD',remote_interval=$5,remote_active=TRUE,validation_state='verified',validated_at=NOW(),validation_error=NULL,updated_at=NOW() WHERE id=$1`, [conflict.rows[0].id, legacy.plan.id, legacy.planPriceId, item.spec.amount, item.spec.interval]);
      } else {
        await client.query(`INSERT INTO plan_provider_prices(plan_id,plan_price_id,provider,external_id,checkout_mode,active,metadata,verified_at,verification_status,remote_amount_minor,remote_currency,remote_interval,remote_active,validation_state,validated_at) VALUES($1,$2,'stripe',$3,'subscription',FALSE,'{"legacyStreamsManager":true}'::jsonb,NOW(),'verified',$4,'USD',$5,TRUE,'verified',NOW())`, [legacy.plan.id, legacy.planPriceId, remote.price.id, item.spec.amount, item.spec.interval]);
      }
    }
    return current.id;
  });
}

async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const asOfArg = argv.find(v => v.startsWith('--as-of='));
  const asOf = asOfArg ? new Date(asOfArg.slice(8)) : new Date();
  if (Number.isNaN(asOf.getTime())) throw new Error('Invalid --as-of date.');
  const files = argv.filter(v => !v.startsWith('--'));
  if (!files.length) throw new Error('Pass one or more StreamsManager Payments CSV files. Dry-run is the default; add --apply to write.');
  files.forEach(f => { if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`); });
  const parsed = activePayments(files, asOf);
  const specs = [...new Set(parsed.eligible.map(x => x.spec))];
  const sources = {};
  for (const spec of specs) sources[spec.key] = await sourcePlan(spec);
  const legacyPlans = {};
  if (apply) {
    await transaction(async client => {
      for (const spec of specs) legacyPlans[spec.key] = await ensureLegacyPlan(client, spec, sources[spec.key]);
    });
  }
  const stripe = await stripeClient();
  const report = { mode: apply ? 'apply' : 'audit', asOf: asOf.toISOString(), dedupedPayments: parsed.dedupedPayments, activeEmails: parsed.activeEmails, legacyEligible: parsed.eligible.length, csvReview: parsed.review.length, moved: 0, alreadyCorrect: 0, dbReview: [], stripeVerified: 0, stripeUnresolved: 0, cohorts: {} };
  for (const item of parsed.eligible) {
    report.cohorts[item.spec.key] = (report.cohorts[item.spec.key] || 0) + 1;
    const target = await localTarget(item.email, item.spec);
    if (target.error) { report.dbReview.push({ email: item.email, reason: target.error }); continue; }
    const localPrice = Number(target.subscription.price_minor_snapshot);
    const already = target.subscription.current_plan_code === item.spec.code && localPrice === item.spec.amount;
    if (already) { report.alreadyCorrect += 1; continue; }
    const remote = await resolveRemote(stripe, item.email, target.subscription, item.spec);
    if (remote.state === 'verified') report.stripeVerified += 1; else report.stripeUnresolved += 1;
    if (remote.state === 'mismatch') { report.dbReview.push({ email: item.email, reason: remote.reason }); continue; }
    if (apply) { await applyOne(item, target, remote, legacyPlans); report.moved += 1; }
  }
  report.csvReviewRows = parsed.review.map(x => ({ email: x.email, reason: x.reason }));
  console.log(JSON.stringify(report, null, 2));
  if (report.dbReview.length || report.csvReview.length) process.exitCode = 2;
  return report;
}

if (require.main === module) main().catch(err => { console.error(err.stack || err); process.exitCode = 1; }).finally(() => closePool().catch(() => {}));
module.exports = { LEGACY, parseCsv, parseUsdMinor, classifyLegacy, activePayments, stripePriceMatch, main };
