'use strict';

// Payment provider facts for new code, so a further provider is added in one
// place. The database owns the matching row-level rules:
// prepaid_row_is_recurring and prepaid_row_is_queueable.
const INCIDENT_PROVIDERS=Object.freeze(['stripe','paypal','plisio']);

module.exports={INCIDENT_PROVIDERS};
