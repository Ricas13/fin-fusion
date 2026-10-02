'use strict';

const { query } = require('../db');

async function setMarketingOptIn(customerId, enabled) {
  const result = await query(
    `UPDATE customers SET marketing_opt_in=$2,updated_at=NOW() WHERE id=$1 RETURNING id`,
    [customerId, Boolean(enabled)]
  );
  if (!result.rowCount) throw new Error('Customer not found.');
  return Boolean(enabled);
}

module.exports = { setMarketingOptIn };
