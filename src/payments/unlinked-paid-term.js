'use strict';

const { transaction } = require('../db');
const billingMode = require('./subscription-billing-mode');

const DISPOSITION_KEY = 'providerLinkDisposition';
const ENDING = 'ending';

function snapshot(row) {
    const value = row?.commercial_snapshot;
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
    catch (_) { return {}; }
}

function disposition(row) {
    return String(snapshot(row)[DISPOSITION_KEY] || '').trim().toLowerCase();
}

function isLegacyImport(row) {
    const value = snapshot(row);
    return value.kind === 'legacy_import' || value.migrated === true;
}

function fixedTermWithoutProvider(row) {
    if (billingMode.isRecurring(row)) return false;
    const mode = billingMode.modeFor(row);
    if (mode === 'payment') return true;
    if (mode === 'manual' && !isLegacyImport(row)) return true;
    return disposition(row) === ENDING;
}

async function setEnding({ subscriptionId, actorUserId = null, ending = true }) {
    return transaction(async client => {
        const result = await client.query(`
            SELECT s.*,p.is_free_tier,p.is_addon,
                   COALESCE(NULLIF(s.commercial_snapshot->>'serverClass',''),p.server_class) AS effective_server_class,
                   COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type) AS effective_service_type,
                   COALESCE(s.price_minor_snapshot,p.price_minor,0) AS effective_price_minor
              FROM subscriptions s
              JOIN plans p ON p.id=s.plan_id
             WHERE s.id=$1
             FOR UPDATE
        `, [subscriptionId]);
        const row = result.rows[0];
        if (!row) throw new Error('Subscription not found.');
        if (row.effective_server_class !== 'premium' || !['jellyfin','bundle'].includes(row.effective_service_type) || Number(row.effective_price_minor) <= 0 || row.is_free_tier || row.is_addon) {
            throw new Error('Only an active paid Premium Server term can use this billing disposition.');
        }
        if (!['active','trialing','past_due','paused'].includes(String(row.status || '')) || new Date(row.current_period_end).getTime() <= Date.now()) {
            throw new Error('This paid term is no longer active.');
        }
        if (billingMode.isRecurring(row)) {
            throw new Error('This subscription is provider-managed. Stop renewal through the provider billing controls instead.');
        }

        const current = snapshot(row);
        const next = { ...current };
        if (ending) {
            next[DISPOSITION_KEY] = ENDING;
            next.providerLinkDispositionReason = 'operator_confirmed_no_renewal';
            next.providerLinkDispositionAt = new Date().toISOString();
        } else {
            delete next[DISPOSITION_KEY];
            delete next.providerLinkDispositionReason;
            delete next.providerLinkDispositionAt;
        }
        const updated = await client.query(`
            UPDATE subscriptions
               SET cancel_at_period_end=$2,
                   commercial_snapshot=$3::jsonb,
                   updated_at=NOW()
             WHERE id=$1
             RETURNING *
        `, [row.id, Boolean(ending), JSON.stringify(next)]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,$2,'subscription',$3,$4::jsonb)
        `, [actorUserId, ending ? 'admin.billing.unlinked_term.mark_ending' : 'admin.billing.unlinked_term.require_provider_link', row.id, JSON.stringify({ customerId:row.customer_id,currentPeriodEnd:row.current_period_end,priorDisposition:disposition(row)||null })]);
        return updated.rows[0];
    });
}

module.exports = { DISPOSITION_KEY, ENDING, snapshot, disposition, isLegacyImport, fixedTermWithoutProvider, setEnding };
