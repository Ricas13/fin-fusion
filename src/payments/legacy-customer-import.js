'use strict';

const { query, transaction } = require('../db');
const subscriptionState = require('../entitlements/subscription-state');
const lifecyclePrimitives = require('./lifecycle-primitives');

const MAX_FILES = 20;
const MAX_PAYLOAD_BYTES = 800 * 1024;
const MAX_ROWS = 10000;
const DAY_MS = 86400000;

function clean(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function emailKey(value) { return clean(value, 320).toLowerCase(); }
function headerKey(value) { return clean(value, 200).replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function parseCsv(text) {
    text = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const rows = [], row = [];
    let field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
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
    return rows.filter(values => values.some(value => clean(value))).map(values => {
        const out = {};
        headers.forEach((header, index) => { if (header && !header.startsWith('unnamed')) out[header] = values[index] == null ? '' : values[index]; });
        return out;
    });
}

function decodePayload(encoded) {
    const raw = clean(encoded, Math.ceil(MAX_PAYLOAD_BYTES * 1.5));
    if (!raw) throw new Error('Choose the legacy Users and Payments CSV files first.');
    let decoded;
    try { decoded = Buffer.from(raw, 'base64').toString('utf8'); } catch (_) { throw new Error('The uploaded CSV payload could not be decoded.'); }
    if (Buffer.byteLength(decoded, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('The combined CSV export is too large for the migration screen.');
    let files;
    try { files = JSON.parse(decoded); } catch (_) { throw new Error('The uploaded CSV payload is not valid.'); }
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error(`Choose between 1 and ${MAX_FILES} CSV files.`);
    return files.map(file => ({ name: clean(file?.name, 180), text: String(file?.text == null ? '' : file.text) })).filter(file => file.text.trim());
}

function encodePayload(files) {
    const json = JSON.stringify(files || []);
    if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('The combined CSV export is too large for the migration screen.');
    return Buffer.from(json, 'utf8').toString('base64');
}

function fileKind(rows) {
    if (!rows.length) return null;
    const keys = new Set(Object.keys(rows[0]));
    if (['email','plan','transaction id','processor','amount','from','to'].every(key => keys.has(key))) return 'payments';
    if (keys.has('email') && keys.has('expiration') && (keys.has('id') || keys.has('name'))) return 'users';
    return null;
}

function parseFiles(files) {
    const users = [], payments = [], unknown = [];
    let rowsSeen = 0;
    for (const file of files || []) {
        const rows = parseCsv(file.text);
        rowsSeen += rows.length;
        if (rowsSeen > MAX_ROWS) throw new Error(`Legacy migration is limited to ${MAX_ROWS} CSV rows per run.`);
        const kind = fileKind(rows);
        if (kind === 'users') users.push(...rows.map(row => ({ ...row, _file: file.name })));
        else if (kind === 'payments') payments.push(...rows.map(row => ({ ...row, _file: file.name })));
        else unknown.push(file.name || 'Unnamed CSV');
    }
    if (!payments.length) throw new Error('No Payments export was found. Include at least one CSV with Email, Plan, Transaction ID, Processor, Amount, From and To columns.');
    return { users, payments, unknown };
}

function parseLegacyDate(value) {
    const text = clean(value, 80);
    if (!text) return null;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(' ', 'T') + 'Z' : text;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseMoney(value) {
    const text = clean(value, 80).replace(/,/g, '');
    const currency = text.includes('£') ? 'GBP' : text.includes('€') ? 'EUR' : text.includes('$') ? 'USD' : null;
    const match = text.match(/-?\d+(?:\.\d{1,2})?/);
    if (!match || !currency) return null;
    const amount = Number(match[0]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return { currency, minor: Math.round(amount * 100) };
}

function parseLegacyPlan(value) {
    const name = clean(value, 200);
    const lower = name.toLowerCase();
    const trial = /trial/.test(lower);
    const interval = /6\s*months?|six\s*months?/.test(lower) ? '6_months' : /yearly|annual|\byear\b/.test(lower) ? 'year' : /monthly|\bmonth\b/.test(lower) ? 'month' : trial ? 'trial' : null;
    const streamMatch = lower.match(/(\d+)\s*streams?/);
    const streams = streamMatch ? Number(streamMatch[1]) : null;
    return { name, trial, interval, streams: Number.isInteger(streams) && streams > 0 ? streams : null };
}

function providerName(value) {
    const text = clean(value, 40).toLowerCase();
    if (text === 'stripe') return 'stripe';
    if (text === 'paypal' || text === 'pay pal') return 'paypal';
    if (text === 'manual') return 'manual';
    return null;
}

function uniqueByKey(rows, keyFn) {
    const out = [], seen = new Set();
    for (const row of rows) { const key = keyFn(row); if (!key || seen.has(key)) continue; seen.add(key); out.push(row); }
    return out;
}

function normalizedInputs(files) {
    const parsed = parseFiles(files);
    const users = new Map();
    for (const row of parsed.users) {
        const email = emailKey(row.email);
        if (!email) continue;
        const current = users.get(email);
        const next = { email, legacyUserId: clean(row.id, 100) || null, name: clean(row.name, 100) || null, expiration: parseLegacyDate(row.expiration), file: row._file };
        if (!current || (next.name && !current.name)) users.set(email, next);
    }
    const payments = uniqueByKey(parsed.payments.map(row => {
        const email = emailKey(row.email), provider = providerName(row.processor), money = parseMoney(row.amount), plan = parseLegacyPlan(row.plan), start = parseLegacyDate(row.from), end = parseLegacyDate(row.to);
        const legacyPaymentId = clean(row.id, 100) || null;
        const transactionId = clean(row['transaction id'], 255) || (provider === 'manual' && legacyPaymentId ? `manual-${legacyPaymentId}` : '');
        return { email, provider, transactionId, legacyPaymentId, type: clean(row.type, 50).toLowerCase(), money, plan, start, end, date: parseLegacyDate(row.date), file: row._file, user: users.get(email) || null };
    }), row => `${row.provider || 'invalid'}:${row.transactionId || ''}`);
    return { ...parsed, users, payments };
}

function choosePlan(legacy, plans) {
    if (!legacy?.interval || legacy.interval === 'trial') return { plan: null, reason: 'Legacy plan term could not be mapped.' };
    const intervalPlans = (plans || []).filter(plan => String(plan.billing_interval) === legacy.interval);
    const exact = legacy.streams == null ? [] : intervalPlans.filter(plan => Number(plan.streams || 0) === legacy.streams);
    if (exact.length === 1) return { plan: exact[0], streamOverride: false, reason: null };
    if (exact.length > 1) return { plan: null, reason: `More than one current ${legacy.interval} plan has ${legacy.streams} streams.` };
    if (intervalPlans.length === 1) return { plan: intervalPlans[0], streamOverride: legacy.streams != null && Number(intervalPlans[0].streams || 0) !== legacy.streams, reason: null };
    if (!intervalPlans.length) return { plan: null, reason: `No current direct plan matches legacy term ${legacy.interval}.` };
    return { plan: null, reason: `More than one current plan matches legacy term ${legacy.interval}; choose a unique plan configuration first.` };
}

function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }

function existingPaidDecision(payment, planId, subscriptions) {
    const overlappingRows = (subscriptions || []).filter(sub => overlaps(payment.start, payment.end, new Date(sub.starts_at), new Date(sub.current_period_end)));
    const recurring = overlappingRows.find(sub => subscriptionState.LIVE_STATUSES.includes(String(sub.status || '')) && subscriptionState.recurringProvider(sub));
    if (recurring) return { kind: 'covered_recurring', subscription: recurring };
    const localPaid = overlappingRows.filter(sub => String(sub.status || '') === 'active' && !subscriptionState.recurringProvider(sub) && Number(sub.effective_price_minor || 0) > 0);
    const covering = localPaid.find(sub => new Date(sub.starts_at) <= payment.start && new Date(sub.current_period_end) >= payment.end);
    if (covering) return { kind: 'covered', subscription: covering };
    if (!localPaid.length) return { kind: 'none', subscription: null };
    if (localPaid.length > 1) return { kind: 'review', subscription: null, reason: 'More than one active local paid subscription overlaps this legacy term.' };
    const partial = localPaid[0];
    if (String(partial.plan_id) !== String(planId)) return { kind: 'review', subscription: partial, reason: 'Existing local paid access overlaps this legacy term on a different plan.' };
    return { kind: 'extend', subscription: partial };
}

async function loadContext(emails, transactionKeys, legacyNames = []) {
    const normalizedEmails = Array.from(new Set(emails.filter(Boolean)));
    const normalizedNames = Array.from(new Set((legacyNames || []).map(value => clean(value, 100).toLowerCase()).filter(Boolean)));
    const [plansResult, customersResult, orphanUsersResult, importedResult, jellyfinResult] = await Promise.all([
        query(`SELECT id,name,code,billing_interval,duration_days,price_minor,currency,streams,service_type,server_class,is_free_tier FROM plans WHERE active=TRUE AND visible=TRUE AND archived_at IS NULL AND COALESCE(is_addon,FALSE)=FALSE AND audience='direct' AND service_type IN ('jellyfin','bundle') AND billing_interval IN ('month','6_months','year') ORDER BY sort_order,price_minor,name`),
        normalizedEmails.length ? query(`SELECT c.id,c.user_id,c.display_name,COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')) email FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE lower(COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')))=ANY($1::text[])`, [normalizedEmails]) : { rows: [] },
        normalizedEmails.length ? query(`SELECT u.id,u.username,u.email FROM app_users u LEFT JOIN customers c ON c.user_id=u.id WHERE u.role='customer' AND c.id IS NULL AND lower(COALESCE(u.email,''))=ANY($1::text[])`, [normalizedEmails]) : { rows: [] },
        transactionKeys.length ? query(`SELECT provider,provider_transaction_id,customer_id,subscription_id FROM legacy_subscription_imports WHERE (provider || ':' || provider_transaction_id)=ANY($1::text[])`, [transactionKeys]) : { rows: [] },
        normalizedNames.length ? query(`SELECT DISTINCT c.id,c.user_id,c.display_name,COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')) email,lower(ja.jellyfin_username) jellyfin_username FROM jellyfin_accounts ja JOIN customers c ON c.id=ja.customer_id LEFT JOIN app_users u ON u.id=c.user_id WHERE COALESCE(ja.account_purpose,'jellyfin')='jellyfin' AND lower(ja.jellyfin_username)=ANY($1::text[])`, [normalizedNames]) : { rows: [] }
    ]);
    const customersByEmail = new Map(), customersByJellyfinName = new Map(), orphanUsersByEmail = new Map(), imported = new Map();
    for (const row of customersResult.rows) {
        const key = emailKey(row.email); if (!customersByEmail.has(key)) customersByEmail.set(key, []); customersByEmail.get(key).push(row);
    }
    for (const row of orphanUsersResult.rows) {
        const key = emailKey(row.email); if (!orphanUsersByEmail.has(key)) orphanUsersByEmail.set(key, []); orphanUsersByEmail.get(key).push(row);
    }
    for (const row of jellyfinResult.rows) {
        const key = clean(row.jellyfin_username, 100).toLowerCase(); if (!customersByJellyfinName.has(key)) customersByJellyfinName.set(key, []); customersByJellyfinName.get(key).push(row);
    }
    for (const row of importedResult.rows) imported.set(`${row.provider}:${row.provider_transaction_id}`, row);
    const customerIds = Array.from(new Set([...customersResult.rows, ...jellyfinResult.rows].map(row => row.id)));
    const subscriptions = customerIds.length ? (await query(`SELECT s.*,p.is_free_tier,COALESCE(s.price_minor_snapshot,p.price_minor,0) effective_price_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=ANY($1::uuid[]) AND s.superseded_by IS NULL AND s.current_period_end>NOW() ORDER BY s.starts_at,s.current_period_end`, [customerIds])).rows : [];
    const subscriptionsByCustomer = new Map();
    for (const row of subscriptions) { const key = String(row.customer_id); if (!subscriptionsByCustomer.has(key)) subscriptionsByCustomer.set(key, []); subscriptionsByCustomer.get(key).push(row); }
    return { plans: plansResult.rows, customersByEmail, customersByJellyfinName, orphanUsersByEmail, imported, subscriptionsByCustomer };
}

function basicCandidate(payment, now) {
    if (!payment.email || !payment.email.includes('@')) return { state: 'review', reason: 'Payment row has no valid email.' };
    if (!payment.provider) return { state: 'review', reason: 'Payment processor is not Stripe, PayPal or Manual.' };
    if (!payment.transactionId) return { state: 'review', reason: 'Payment row has no transaction ID.' };
    if (payment.type && payment.type !== 'payment') return { state: 'excluded', reason: 'Only legacy payment rows can restore access.' };
    if (!payment.money) return { state: 'review', reason: 'Legacy payment amount/currency could not be read.' };
    if (payment.plan.trial || payment.money.minor === 0) return { state: 'excluded', reason: 'Trials/free payments are never activated by the paid-user migration.' };
    if (!payment.start || !payment.end || payment.end <= payment.start) return { state: 'review', reason: 'Legacy subscription From/To dates are missing or invalid.' };
    if (payment.end <= now) return { state: 'expired', reason: 'Paid term has already expired.' };
    return { state: payment.start > now ? 'ready_future' : 'ready_current', reason: payment.start > now ? 'Prepaid future term will be scheduled.' : 'Current paid term can be restored.' };
}

async function preview(files, { now = new Date() } = {}) {
    const input = normalizedInputs(files);
    const keys = input.payments.map(row => `${row.provider || 'invalid'}:${row.transactionId || ''}`).filter(key => !key.endsWith(':'));
    const context = await loadContext(input.payments.map(row => row.email), keys, [...input.users.values()].map(row => row.name).filter(Boolean));
    const candidates = [];
    for (const payment of input.payments) {
        const base = basicCandidate(payment, now);
        const match = choosePlan(payment.plan, context.plans);
        const row = { ...payment, ...base, planMatch: match.plan || null, streamOverride: Boolean(match.streamOverride), customer: null, customerMatch: null, createCustomer: false, linkUserId: null, needsJellyfinLink: false, extendSubscriptionId: null };
        if (['ready_current','ready_future'].includes(row.state)) {
            if (!match.plan) { row.state = 'review'; row.reason = match.reason; }
            const imported = context.imported.get(`${payment.provider}:${payment.transactionId}`);
            if (imported) { row.state = 'already_imported'; row.reason = 'This legacy transaction has already been imported.'; row.customer = { id: imported.customer_id }; }
        }
        if (['ready_current','ready_future'].includes(row.state)) {
            const matches = context.customersByEmail.get(payment.email) || [];
            const orphanUsers = context.orphanUsersByEmail.get(payment.email) || [];
            const jellyfinKey = clean(payment.user?.name, 100).toLowerCase();
            const jellyfinMatches = jellyfinKey ? (context.customersByJellyfinName.get(jellyfinKey) || []) : [];
            if (matches.length > 1) { row.state = 'review'; row.reason = 'More than one portal customer has this email.'; }
            else if (matches.length === 1) {
                const conflict = jellyfinMatches.find(item => String(item.id) !== String(matches[0].id));
                if (conflict) { row.state = 'review'; row.reason = 'Legacy email and Jellyfin username point to different CAPTAiNFiN customers.'; }
                else { row.customer = matches[0]; row.customerMatch = 'email'; }
            }
            else if (jellyfinMatches.length > 1) { row.state = 'review'; row.reason = 'More than one managed Jellyfin identity matches the legacy username.'; }
            else if (jellyfinMatches.length === 1) { row.customer = jellyfinMatches[0]; row.customerMatch = 'jellyfin_username'; row.reason = 'Matched the existing managed Jellyfin user from the legacy Users export.'; }
            else if (orphanUsers.length > 1) { row.state = 'review'; row.reason = 'More than one unlinked portal login has this email.'; }
            else {
                row.createCustomer = true; row.linkUserId = orphanUsers[0]?.id || null; row.needsJellyfinLink = true;
                row.reason = row.state === 'ready_future' ? 'Prepaid future term will be scheduled; link the existing Jellyfin identity before it starts.' : 'Paid term can be restored locally; link the existing Jellyfin identity before CAPTAiNFiN provisioning.';
            }
        }
        if (['ready_current','ready_future'].includes(row.state) && row.customer) {
            const subscriptions = context.subscriptionsByCustomer.get(String(row.customer.id)) || [];
            const decision = existingPaidDecision(payment, row.planMatch?.id, subscriptions);
            if (decision.kind === 'covered_recurring') { row.state = 'covered'; row.reason = 'A live provider-managed recurring subscription already covers this customer.'; }
            else if (decision.kind === 'covered') { row.state = 'covered'; row.reason = 'Existing paid access already covers at least this legacy term.'; }
            else if (decision.kind === 'review') { row.state = 'review'; row.reason = decision.reason; }
            else if (decision.kind === 'extend') {
                row.extendSubscriptionId = decision.subscription.id;
                row.reason = 'Existing local paid access will be extended to the later trusted legacy expiry.';
            }
            const free = subscriptions.find(sub => Boolean(sub.is_free_tier) && overlaps(payment.start, payment.end, new Date(sub.starts_at), new Date(sub.current_period_end)));
            if (free && row.state === 'ready_future' && !row.extendSubscriptionId) { row.state = 'review'; row.reason = 'A future paid term cannot safely replace current free access until its start date.'; }
        }
        candidates.push(row);
    }

    const readyByEmail = new Map();
    for (const row of candidates.filter(row => ['ready_current','ready_future'].includes(row.state))) {
        if (!readyByEmail.has(row.email)) readyByEmail.set(row.email, []); readyByEmail.get(row.email).push(row);
    }
    for (const rows of readyByEmail.values()) {
        rows.sort((a, b) => a.start - b.start);
        for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
            if (overlaps(rows[i].start, rows[i].end, rows[j].start, rows[j].end)) {
                rows[i].state = rows[j].state = 'review'; rows[i].reason = rows[j].reason = 'Two paid legacy terms overlap for the same email; review before importing.';
            }
        }
    }

    const counts = { files: files.length, userRows: input.users.size, paymentRows: input.payments.length, current: 0, future: 0, extend: 0, ready: 0, covered: 0, imported: 0, review: 0, expired: 0, excluded: 0 };
    for (const row of candidates) {
        if (row.state === 'ready_current') counts.current++;
        if (row.state === 'ready_future') counts.future++;
        if (['ready_current','ready_future'].includes(row.state)) counts.ready++;
        if (row.extendSubscriptionId && ['ready_current','ready_future'].includes(row.state)) counts.extend++;
        if (row.state === 'covered') counts.covered++;
        if (row.state === 'already_imported') counts.imported++;
        if (row.state === 'review') counts.review++;
        if (row.state === 'expired') counts.expired++;
        if (row.state === 'excluded') counts.excluded++;
    }
    return { files: files.map(file => file.name), unknownFiles: input.unknown, candidates, counts };
}

async function resolveCustomerTx(client, candidate) {
    if (candidate.customerMatch === 'jellyfin_username' && candidate.customer?.id && candidate.user?.name) {
        const linked = await client.query(`SELECT c.id,c.user_id FROM customers c JOIN jellyfin_accounts ja ON ja.customer_id=c.id WHERE c.id=$1 AND COALESCE(ja.account_purpose,'jellyfin')='jellyfin' AND lower(ja.jellyfin_username)=lower($2) LIMIT 1 FOR UPDATE OF c`, [candidate.customer.id, clean(candidate.user.name, 100)]);
        if (!linked.rowCount) throw new Error(`Managed Jellyfin identity changed for ${candidate.email} after preview; import stopped for review.`);
        return { row: linked.rows[0], created: false, matchedByJellyfin: true };
    }
    const found = await client.query(`SELECT c.id,c.user_id FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE lower(COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')))=lower($1) FOR UPDATE OF c`, [candidate.email]);
    if (found.rowCount > 1) throw new Error(`Multiple customers now match ${candidate.email}.`);
    if (found.rowCount === 1) return { row: found.rows[0], created: false, matchedByJellyfin: false };
    const orphan = await client.query(`SELECT u.id,u.username FROM app_users u LEFT JOIN customers c ON c.user_id=u.id WHERE u.role='customer' AND c.id IS NULL AND lower(COALESCE(u.email,''))=lower($1) FOR UPDATE OF u`, [candidate.email]);
    if (orphan.rowCount > 1) throw new Error(`Multiple portal logins now match ${candidate.email}.`);
    const displayName = clean(candidate.user?.name || orphan.rows[0]?.username, 100) || null;
    const inserted = await client.query(`INSERT INTO customers(user_id,display_name,email,note) VALUES($1,$2,$3,$4) RETURNING id,user_id`, [orphan.rows[0]?.id || null, displayName, candidate.email, 'Imported from legacy paid-user CSV migration']);
    return { row: inserted.rows[0], created: true, matchedByJellyfin: false };
}

function commercialSnapshot(candidate, plan) {
    return {
        kind: 'legacy_import',
        planId: plan.id,
        planCode: plan.code,
        planName: plan.name,
        priceMinor: candidate.money.minor,
        currency: candidate.money.currency,
        billingInterval: plan.billing_interval,
        durationDays: Number(plan.duration_days || Math.max(1, Math.round((candidate.end - candidate.start) / DAY_MS))),
        streams: candidate.plan.streams || Number(plan.streams || 1),
        serverClass: plan.server_class,
        legacyProvider: candidate.provider,
        legacyTransactionId: candidate.transactionId,
        legacyPaymentId: candidate.legacyPaymentId,
        legacyPlanName: candidate.plan.name,
        legacyUserId: candidate.user?.legacyUserId || null,
        migrated: true
    };
}

async function importSafe(files, actorUserId, { now = new Date() } = {}) {
    const checked = await preview(files, { now });
    const ready = checked.candidates.filter(row => ['ready_current','ready_future'].includes(row.state)).sort((a, b) => a.start - b.start);
    if (!ready.length) return { ...checked, imported: [], createdCustomers: 0, provisionedCustomers: 0 };
    const result = await transaction(async client => {
        const imported = [], customerIds = new Set(); let createdCustomers = 0, extendedSubscriptions = 0;
        for (const candidate of ready) {
            const prior = await client.query(`SELECT id FROM legacy_subscription_imports WHERE source_system='legacy_csv' AND provider=$1 AND provider_transaction_id=$2 FOR UPDATE`, [candidate.provider, candidate.transactionId]);
            if (prior.rowCount) continue;
            const customer = await resolveCustomerTx(client, candidate); if (customer.created) createdCustomers++;
            const planResult = await client.query(`SELECT id,name,code,billing_interval,duration_days,price_minor,currency,streams,service_type,server_class,is_free_tier FROM plans WHERE id=$1 AND active=TRUE AND visible=TRUE AND archived_at IS NULL AND COALESCE(is_addon,FALSE)=FALSE AND audience='direct' FOR UPDATE`, [candidate.planMatch.id]);
            if (!planResult.rowCount) throw new Error(`Mapped plan for ${candidate.email} is no longer available.`);
            const plan = planResult.rows[0];
            const activeSubs = await client.query(`SELECT s.*,p.is_free_tier,COALESCE(s.price_minor_snapshot,p.price_minor,0) effective_price_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=$1 AND s.superseded_by IS NULL AND s.current_period_end>NOW() FOR UPDATE OF s`, [customer.row.id]);
            const decision = existingPaidDecision(candidate, plan.id, activeSubs.rows);
            if (['covered_recurring','covered'].includes(decision.kind)) continue;
            if (decision.kind === 'review') throw new Error(`Paid access changed for ${candidate.email} after preview: ${decision.reason}`);
            const snapshot = commercialSnapshot(candidate, plan);
            let subscription, extendedExisting = false;
            if (decision.kind === 'extend') {
                const extended = await client.query(`UPDATE subscriptions SET starts_at=LEAST(starts_at,$2),current_period_end=GREATEST(current_period_end,$3),cancel_at_period_end=TRUE,updated_at=NOW() WHERE id=$1 AND customer_id=$4 AND plan_id=$5 AND superseded_by IS NULL AND status='active' RETURNING *`, [decision.subscription.id, candidate.start, candidate.end, customer.row.id, plan.id]);
                if (!extended.rowCount) throw new Error(`Existing paid access changed for ${candidate.email} after preview; import stopped for review.`);
                subscription = extended.rows[0];
                extendedExisting = true;
                extendedSubscriptions++;
            } else {
                const inserted = await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,cancel_at_period_end,plan_name_snapshot,plan_code_snapshot,price_minor_snapshot,currency_snapshot,billing_interval_snapshot,duration_days_snapshot,service_type_snapshot,commercial_snapshot) VALUES($1,$2,'active','migration',$3,$4,TRUE,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`, [customer.row.id, plan.id, candidate.start, candidate.end, plan.name, plan.code, candidate.money.minor, candidate.money.currency, plan.billing_interval, Number(plan.duration_days || 30), plan.service_type, JSON.stringify(snapshot)]);
                subscription = inserted.rows[0];
            }
            if (candidate.start <= now) {
                const free = activeSubs.rows.find(sub => Boolean(sub.is_free_tier) && new Date(sub.starts_at) <= now && new Date(sub.current_period_end) > now);
                if (free) await subscriptionState.markSuperseded(client, { subscriptionId: free.id, replacementId: subscription.id, reason: 'legacy_paid_migration' });
            }
            await client.query(`INSERT INTO legacy_subscription_imports(source_system,provider,provider_transaction_id,legacy_payment_id,legacy_user_id,email,legacy_plan_name,plan_id,customer_id,subscription_id,amount_minor,currency,period_start,period_end,metadata,requested_by) VALUES('legacy_csv',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`, [candidate.provider, candidate.transactionId, candidate.legacyPaymentId, candidate.user?.legacyUserId || null, candidate.email, candidate.plan.name, plan.id, customer.row.id, subscription.id, candidate.money.minor, candidate.money.currency, candidate.start, candidate.end, JSON.stringify({ file: candidate.file, streamOverride: candidate.streamOverride, legacyStreams: candidate.plan.streams, currentPlanStreams: plan.streams, extendedExisting }), actorUserId || null]);
            await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.legacy_subscription.import','subscription',$2,$3::jsonb)`, [actorUserId || null, subscription.id, JSON.stringify({ customerId: customer.row.id, provider: candidate.provider, transactionId: candidate.transactionId, legacyPlanName: candidate.plan.name, periodStart: candidate.start, periodEnd: candidate.end, amountMinor: candidate.money.minor, currency: candidate.money.currency, noProviderCharge: true, extendedExisting })]);
            let linkedJellyfin = false;
            if (candidate.start <= now) {
                const managedAccount = await client.query(`SELECT 1 FROM jellyfin_accounts WHERE customer_id=$1 AND COALESCE(account_purpose,'jellyfin')='jellyfin' LIMIT 1`, [customer.row.id]);
                linkedJellyfin = managedAccount.rowCount > 0;
                if (linkedJellyfin) customerIds.add(String(customer.row.id));
            }
            imported.push({ customerId: customer.row.id, subscriptionId: subscription.id, email: candidate.email, future: candidate.start > now, needsJellyfinLink: candidate.start <= now && !linkedJellyfin, extendedExisting });
        }
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.legacy_subscription.batch_import','legacy_subscription_import','legacy_csv',$2::jsonb)`, [actorUserId || null, JSON.stringify({ candidates: ready.length, imported: imported.length, createdCustomers, extendedSubscriptions, currentCustomersToReconcile: customerIds.size })]);
        return { imported, createdCustomers, extendedSubscriptions, customerIds: [...customerIds] };
    });
    for (const customerId of result.customerIds) await lifecyclePrimitives.reconcileCommittedCustomer(customerId, 'Legacy paid-user migration');
    return { ...checked, imported: result.imported, createdCustomers: result.createdCustomers, extendedSubscriptions: result.extendedSubscriptions, provisionedCustomers: result.customerIds.length, pendingJellyfinLinks: result.imported.filter(row => row.needsJellyfinLink).length };
}

module.exports = {
    MAX_FILES, MAX_PAYLOAD_BYTES, MAX_ROWS,
    parseCsv, parseFiles, decodePayload, encodePayload, parseLegacyDate, parseMoney, parseLegacyPlan, providerName,
    normalizedInputs, choosePlan, basicCandidate, existingPaidDecision, commercialSnapshot, preview, importSafe
};
