'use strict';

const { query } = require('../db');
const incidents = require('./incidents');

async function record({ provider, eventId, caseId, providerSubscriptionId, amountMinor = null, currency = null, metadata = {} }) {
    if (!provider || !eventId || !caseId || !providerSubscriptionId) return null;
    const identity = await incidents.identityFromProviderSubscription(provider, providerSubscriptionId);
    const payload = {
        ...(metadata || {}),
        lastProviderEventId: String(eventId),
        lastSeenAt: new Date().toISOString()
    };
    const result = await query(`
        INSERT INTO payment_incidents(
            provider,provider_event_id,provider_case_id,incident_type,incident_status,
            scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata
        ) VALUES($1,$2,$3,'failed_renewal','open',$4,$5,$6,$7,$8,'provider_state',$9::jsonb)
        ON CONFLICT (provider,provider_case_id,incident_type)
        WHERE provider_case_id IS NOT NULL
          AND incident_type='failed_renewal'
          AND incident_status='open'
        DO UPDATE SET
            scope=CASE
                WHEN payment_incidents.scope='unresolved' AND EXCLUDED.scope<>'unresolved' THEN EXCLUDED.scope
                ELSE payment_incidents.scope
            END,
            customer_id=COALESCE(payment_incidents.customer_id,EXCLUDED.customer_id),
            provider_subscription_id=COALESCE(payment_incidents.provider_subscription_id,EXCLUDED.provider_subscription_id),
            amount_minor=COALESCE(EXCLUDED.amount_minor,payment_incidents.amount_minor),
            currency=COALESCE(EXCLUDED.currency,payment_incidents.currency),
            metadata=payment_incidents.metadata || EXCLUDED.metadata,
            updated_at=NOW()
        RETURNING *
    `, [
        provider,
        String(eventId),
        String(caseId),
        identity.scope || 'unresolved',
        identity.customerId || null,
        String(providerSubscriptionId),
        amountMinor == null ? null : Number(amountMinor),
        currency ? String(currency).toUpperCase().slice(0, 3) : null,
        JSON.stringify(payload)
    ]);
    return result.rows[0] || null;
}

async function resolveOpen({ provider, providerSubscriptionId = null, providerCaseId = null, note }) {
    if (!provider || (!providerSubscriptionId && !providerCaseId)) return 0;
    const result = await query(`
        UPDATE payment_incidents
        SET incident_status='resolved',
            resolved_at=COALESCE(resolved_at,NOW()),
            resolution_note=COALESCE(resolution_note,$4),
            updated_at=NOW()
        WHERE provider=$1
          AND incident_type='failed_renewal'
          AND incident_status='open'
          AND ($2::text IS NULL OR provider_subscription_id=$2)
          AND ($3::text IS NULL OR provider_case_id=$3)
        RETURNING id
    `, [
        provider,
        providerSubscriptionId ? String(providerSubscriptionId) : null,
        providerCaseId ? String(providerCaseId) : null,
        String(note || 'Provider renewal case is no longer actionable.').slice(0, 4000)
    ]);
    return result.rowCount;
}

module.exports = { record, resolveOpen };
