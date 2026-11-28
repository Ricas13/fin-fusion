'use strict';

const { query } = require('../db');

// Payment-evidence mismatches never withhold access from a customer the provider reports as paid. They open (or refresh) an
// operator-visible `checkout_completion` incident instead. The incident is access-neutral ('preserve') and idempotent per
// provider reference, so webhook and return replays never create duplicates.
async function flagForReview({ provider, customerId, providerReference, checkoutIntentId = null, reasons = [], detail = {} }) {
  const list = (reasons || []).map(String).filter(Boolean);
  if (!list.length || !providerReference) return null;
  try {
    const result = await query(`
      INSERT INTO payment_incidents(
        provider,provider_event_id,provider_case_id,incident_type,incident_status,
        scope,customer_id,provider_subscription_id,access_action,metadata
      ) VALUES($1,$2,$3,'checkout_completion','open','direct',$4,$5,'preserve',$6::jsonb)
      ON CONFLICT(provider,provider_event_id,incident_type) DO UPDATE SET
        updated_at=NOW(),
        metadata=payment_incidents.metadata || EXCLUDED.metadata
      RETURNING *
    `, [provider, `settlement-review:${String(providerReference)}`, checkoutIntentId ? String(checkoutIntentId) : null,
      customerId || null, String(providerReference),
      JSON.stringify({ reason: 'paid_settlement_needs_review', reviewReasons: list, ...detail })]);
    return result.rows[0] || null;
  } catch (error) {
    // Flagging is bookkeeping; it must never stop a paid customer receiving access.
    console.error(`Could not record settlement review for ${provider} ${providerReference}: ${error.message}`);
    return null;
  }
}

module.exports = { flagForReview };
