from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"Expected patch target not found in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))

service = 'src/payments/legacy-customer-import.js'
replace_once(
    service,
    "function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }\n",
    "function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }\n\nfunction existingPaidDecision(payment, planId, subscriptions) {\n    const overlappingRows = (subscriptions || []).filter(sub => overlaps(payment.start, payment.end, new Date(sub.starts_at), new Date(sub.current_period_end)));\n    const recurring = overlappingRows.find(sub => subscriptionState.LIVE_STATUSES.includes(String(sub.status || '')) && subscriptionState.recurringProvider(sub));\n    if (recurring) return { kind: 'covered_recurring', subscription: recurring };\n    const localPaid = overlappingRows.filter(sub => String(sub.status || '') === 'active' && !subscriptionState.recurringProvider(sub) && Number(sub.effective_price_minor || 0) > 0);\n    const covering = localPaid.find(sub => new Date(sub.starts_at) <= payment.start && new Date(sub.current_period_end) >= payment.end);\n    if (covering) return { kind: 'covered', subscription: covering };\n    if (!localPaid.length) return { kind: 'none', subscription: null };\n    if (localPaid.length > 1) return { kind: 'review', subscription: null, reason: 'More than one active local paid subscription overlaps this legacy term.' };\n    const partial = localPaid[0];\n    if (String(partial.plan_id) !== String(planId)) return { kind: 'review', subscription: partial, reason: 'Existing local paid access overlaps this legacy term on a different plan.' };\n    return { kind: 'extend', subscription: partial };\n}\n"
)
replace_once(
    service,
    "        const row = { ...payment, ...base, planMatch: match.plan || null, streamOverride: Boolean(match.streamOverride), customer: null, customerMatch: null, createCustomer: false, linkUserId: null, needsJellyfinLink: false };",
    "        const row = { ...payment, ...base, planMatch: match.plan || null, streamOverride: Boolean(match.streamOverride), customer: null, customerMatch: null, createCustomer: false, linkUserId: null, needsJellyfinLink: false, extendSubscriptionId: null };"
)
old_preview = """        if (['ready_current','ready_future'].includes(row.state) && row.customer) {
            const subscriptions = context.subscriptionsByCustomer.get(String(row.customer.id)) || [];
            const recurring = subscriptions.find(sub => subscriptionState.recurringProvider(sub) && overlaps(payment.start, payment.end, new Date(sub.starts_at), new Date(sub.current_period_end)));
            if (recurring) { row.state = 'covered'; row.reason = 'A live provider-managed recurring subscription already covers this customer.'; }
            else {
                const paid = subscriptions.find(sub => Number(sub.effective_price_minor || 0) > 0 && overlaps(payment.start, payment.end, new Date(sub.starts_at), new Date(sub.current_period_end)));
                if (paid && new Date(paid.current_period_end) >= payment.end) { row.state = 'covered'; row.reason = 'Existing paid access already covers at least this legacy term.'; }
                else if (paid) { row.state = 'review'; row.reason = 'Existing paid access overlaps this legacy term but does not fully cover it.'; }
                const free = subscriptions.find(sub => Boolean(sub.is_free_tier) && overlaps(payment.start, payment.end, new Date(sub.starts_at), new Date(sub.current_period_end)));
                if (free && row.state === 'ready_future') { row.state = 'review'; row.reason = 'A future paid term cannot safely replace current free access until its start date.'; }
            }
        }
"""
new_preview = """        if (['ready_current','ready_future'].includes(row.state) && row.customer) {
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
"""
replace_once(service, old_preview, new_preview)
replace_once(
    service,
    "    const counts = { files: files.length, userRows: input.users.size, paymentRows: input.payments.length, current: 0, future: 0, ready: 0, covered: 0, imported: 0, review: 0, expired: 0, excluded: 0 };",
    "    const counts = { files: files.length, userRows: input.users.size, paymentRows: input.payments.length, current: 0, future: 0, extend: 0, ready: 0, covered: 0, imported: 0, review: 0, expired: 0, excluded: 0 };"
)
replace_once(
    service,
    "        if (['ready_current','ready_future'].includes(row.state)) counts.ready++;",
    "        if (['ready_current','ready_future'].includes(row.state)) counts.ready++;\n        if (row.extendSubscriptionId && ['ready_current','ready_future'].includes(row.state)) counts.extend++;"
)
replace_once(
    service,
    "        const imported = [], customerIds = new Set(); let createdCustomers = 0;",
    "        const imported = [], customerIds = new Set(); let createdCustomers = 0, extendedSubscriptions = 0;"
)
old_apply = """            const recurring = activeSubs.rows.find(sub => subscriptionState.recurringProvider(sub) && overlaps(candidate.start, candidate.end, new Date(sub.starts_at), new Date(sub.current_period_end)));
            if (recurring) continue;
            const coveringPaid = activeSubs.rows.find(sub => Number(sub.effective_price_minor || 0) > 0 && new Date(sub.starts_at) <= candidate.start && new Date(sub.current_period_end) >= candidate.end);
            if (coveringPaid) continue;
            const conflictingPaid = activeSubs.rows.find(sub => Number(sub.effective_price_minor || 0) > 0 && overlaps(candidate.start, candidate.end, new Date(sub.starts_at), new Date(sub.current_period_end)));
            if (conflictingPaid) throw new Error(`Paid access changed for ${candidate.email} after preview; import stopped for review.`);
            const snapshot = commercialSnapshot(candidate, plan);
            const inserted = await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,cancel_at_period_end,plan_name_snapshot,plan_code_snapshot,price_minor_snapshot,currency_snapshot,billing_interval_snapshot,duration_days_snapshot,service_type_snapshot,commercial_snapshot) VALUES($1,$2,'active','migration',$3,$4,TRUE,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`, [customer.row.id, plan.id, candidate.start, candidate.end, plan.name, plan.code, candidate.money.minor, candidate.money.currency, plan.billing_interval, Number(plan.duration_days || 30), plan.service_type, JSON.stringify(snapshot)]);
            const subscription = inserted.rows[0];
"""
new_apply = """            const decision = existingPaidDecision(candidate, plan.id, activeSubs.rows);
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
"""
replace_once(service, old_apply, new_apply)
replace_once(
    service,
    "JSON.stringify({ file: candidate.file, streamOverride: candidate.streamOverride, legacyStreams: candidate.plan.streams, currentPlanStreams: plan.streams })",
    "JSON.stringify({ file: candidate.file, streamOverride: candidate.streamOverride, legacyStreams: candidate.plan.streams, currentPlanStreams: plan.streams, extendedExisting })"
)
replace_once(
    service,
    "JSON.stringify({ customerId: customer.row.id, provider: candidate.provider, transactionId: candidate.transactionId, legacyPlanName: candidate.plan.name, periodStart: candidate.start, periodEnd: candidate.end, amountMinor: candidate.money.minor, currency: candidate.money.currency, noProviderCharge: true })",
    "JSON.stringify({ customerId: customer.row.id, provider: candidate.provider, transactionId: candidate.transactionId, legacyPlanName: candidate.plan.name, periodStart: candidate.start, periodEnd: candidate.end, amountMinor: candidate.money.minor, currency: candidate.money.currency, noProviderCharge: true, extendedExisting })"
)
replace_once(
    service,
    "            imported.push({ customerId: customer.row.id, subscriptionId: subscription.id, email: candidate.email, future: candidate.start > now, needsJellyfinLink: candidate.start <= now && !linkedJellyfin });",
    "            imported.push({ customerId: customer.row.id, subscriptionId: subscription.id, email: candidate.email, future: candidate.start > now, needsJellyfinLink: candidate.start <= now && !linkedJellyfin, extendedExisting });"
)
replace_once(
    service,
    "JSON.stringify({ candidates: ready.length, imported: imported.length, createdCustomers, currentCustomersToReconcile: customerIds.size })",
    "JSON.stringify({ candidates: ready.length, imported: imported.length, createdCustomers, extendedSubscriptions, currentCustomersToReconcile: customerIds.size })"
)
replace_once(
    service,
    "        return { imported, createdCustomers, customerIds: [...customerIds] };",
    "        return { imported, createdCustomers, extendedSubscriptions, customerIds: [...customerIds] };"
)
replace_once(
    service,
    "    return { ...checked, imported: result.imported, createdCustomers: result.createdCustomers, provisionedCustomers: result.customerIds.length, pendingJellyfinLinks: result.imported.filter(row => row.needsJellyfinLink).length };",
    "    return { ...checked, imported: result.imported, createdCustomers: result.createdCustomers, extendedSubscriptions: result.extendedSubscriptions, provisionedCustomers: result.customerIds.length, pendingJellyfinLinks: result.imported.filter(row => row.needsJellyfinLink).length };"
)
replace_once(
    service,
    "    normalizedInputs, choosePlan, basicCandidate, commercialSnapshot, preview, importSafe",
    "    normalizedInputs, choosePlan, basicCandidate, existingPaidDecision, commercialSnapshot, preview, importSafe"
)

admin = 'src/platform/admin-legacy-customer-import.js'
replace_once(
    admin,
    "${esc(stateLabel(row.state))}",
    "${esc(row.extendSubscriptionId ? 'Extend existing access' : stateLabel(row.state))}"
)
replace_once(
    admin,
    "${esc(counts.current)} now · ${esc(counts.future)} future",
    "${esc(counts.current)} now · ${esc(counts.future)} future${Number(counts.extend || 0) ? ` · ${esc(counts.extend)} extension${Number(counts.extend) === 1 ? '' : 's'}` : ''}"
)
replace_once(
    admin,
    "${esc(importedResult.imported.length)} subscription term(s) were restored, ${esc(importedResult.createdCustomers)} customer record(s) were created, and ${esc(importedResult.provisionedCustomers)} current customer(s) with an already-linked Jellyfin identity were sent through access reconciliation.",
    "${esc(importedResult.imported.length)} subscription term(s) were restored${Number(importedResult.extendedSubscriptions || 0) ? `, including ${esc(importedResult.extendedSubscriptions)} safe extension${Number(importedResult.extendedSubscriptions) === 1 ? '' : 's'} of existing local paid access` : ''}, ${esc(importedResult.createdCustomers)} customer record(s) were created, and ${esc(importedResult.provisionedCustomers)} current customer(s) with an already-linked Jellyfin identity were sent through access reconciliation."
)

smoke = 'scripts/legacy-customer-import-smoke.js'
insert_after = "assert.strictEqual(legacy.basicCandidate(input.payments[2], now).state, 'excluded', 'zero-dollar trial rows must never create paid access');\n"
addition = """

const overlapCandidate = { start: new Date('2026-07-22T00:00:00Z'), end: new Date('2027-07-22T00:00:00Z') };
const localPartial = { id: 'local-year', plan_id: 'year', source: 'migration', status: 'active', provider_subscription_id: null, effective_price_minor: 6000, starts_at: new Date('2026-07-22T00:00:00Z'), current_period_end: new Date('2027-01-22T00:00:00Z') };
assert.strictEqual(legacy.existingPaidDecision(overlapCandidate, 'year', [localPartial]).kind, 'extend', 'same-plan local paid access may be safely extended to the trusted legacy expiry');
assert.strictEqual(legacy.existingPaidDecision(overlapCandidate, 'six', [localPartial]).kind, 'review', 'a different-plan overlap must remain manual review');
const liveRecurring = { ...localPartial, id: 'stripe-live', source: 'stripe', provider_subscription_id: 'sub_live_123', status: 'active' };
assert.strictEqual(legacy.existingPaidDecision(overlapCandidate, 'year', [liveRecurring]).kind, 'covered_recurring', 'verified recurring provider access must never be overwritten by CSV migration');
const duplicateLocal = { ...localPartial, id: 'local-year-2' };
assert.strictEqual(legacy.existingPaidDecision(overlapCandidate, 'year', [localPartial, duplicateLocal]).kind, 'review', 'multiple local paid overlaps must never be guessed');
"""
replace_once(smoke, insert_after, insert_after + addition)
replace_once(
    smoke,
    "assert(serviceSource.includes('legacy_subscription_imports') && serviceSource.includes('provider_transaction_id'), 'migration must be idempotent on original provider transaction identity');",
    "assert(serviceSource.includes('legacy_subscription_imports') && serviceSource.includes('provider_transaction_id'), 'migration must be idempotent on original provider transaction identity');\nassert(serviceSource.includes('existingPaidDecision') && serviceSource.includes('GREATEST(current_period_end'), 'same-plan local paid overlaps must use the guarded extension path instead of forcing manual review');\nassert(serviceSource.includes(\"plan_id=$5 AND superseded_by IS NULL AND status='active'\"), 'extension writes must re-check same plan, live status and unsuperseded ownership under lock');"
)
replace_once(
    smoke,
    "assert(adminSource.includes('Matched existing managed Jellyfin user') && adminSource.includes('deliberately did not create a duplicate Jellyfin user'), 'admin preview/result must explain managed-identity matching and safe unlinked handling');",
    "assert(adminSource.includes('Matched existing managed Jellyfin user') && adminSource.includes('deliberately did not create a duplicate Jellyfin user'), 'admin preview/result must explain managed-identity matching and safe unlinked handling');\nassert(adminSource.includes('Extend existing access'), 'safe same-plan legacy extensions must be clearly labelled in the preview UI');"
)

print('PR316 overlap extension patch applied')
