'use strict';

// Regression test for a real incident: migration 20260905141000_drop_whatsapp_schema.sql
// dropped customer_communication_preferences.phone_e164/whatsapp_opt_in, but three live
// code paths (marketing campaign queueing, Jellyfin onboarding notifications, and the
// legacy registerCustomer helper) still referenced those columns by name, so their SQL
// threw "column ... does not exist" every time they ran. Static/string-matching smoke
// tests did not catch this because they never executed the query against a real schema.
// This test actually runs those queries against a migrated database.

const assert = require('assert');
const crypto = require('crypto');
const { query } = require('../src/db');
const campaigns = require('../src/marketing/campaigns');
const provisioningHelpers = require('../src/jellyfin/provisioning-helpers');

async function main() {
  const tag = `whatsapp-removal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const user = (await query(
    `INSERT INTO app_users(email,username,password_hash,role,email_verified_at) VALUES($1,$2,'x','customer',NOW()) RETURNING id`,
    [`${tag}@example.invalid`, tag]
  )).rows[0];
  const customer = (await query(
    `INSERT INTO customers(user_id,display_name,email,marketing_opt_in) VALUES($1,$2,$3,TRUE) RETURNING id`,
    [user.id, tag, `${tag}@example.invalid`]
  )).rows[0];
  await query(
    `INSERT INTO customer_communication_preferences(customer_id,telegram_handle,telegram_opt_in,discord_handle,discord_opt_in) VALUES($1,NULL,FALSE,NULL,FALSE)`,
    [customer.id]
  );

  // 1. Jellyfin onboarding notification must not fail with a schema error when a
  // fresh Jellyfin account is provisioned for a customer with communication
  // preferences on file (this is the exact query that broke).
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  try {
    await provisioningHelpers.notifyNewJellyfinAccess(customer.id, {
      id: crypto.randomUUID(),
      public_url: 'https://jellyfin.example.invalid',
      jellyfin_username: tag,
      password_setup_required: true
    });
  } finally {
    console.warn = originalWarn;
  }
  const schemaWarnings = warnings.filter(w => /does not exist/i.test(w));
  assert.deepStrictEqual(schemaWarnings, [], `Jellyfin onboarding notification must not fail with a schema error: ${schemaWarnings.join(' | ')}`);

  // 2. Marketing campaign queueing must not fail with a schema error either -
  // exercise the full create -> queue path end to end for a real opted-in customer.
  const campaign = await campaigns.create({
    name: `${tag} campaign`,
    subject: 'WhatsApp removal regression',
    bodyText: 'Regression coverage for dropped communication-preference columns.',
    discountCodeId: null,
    audienceFilters: { status: 'none' },
    adminUserId: null
  });
  const result = await campaigns.queue({ campaignId: campaign.id, adminUserId: null });
  assert(Number.isInteger(result.queued) && Number.isInteger(result.suppressed), 'campaign queue must return numeric queued/suppressed counts, not throw a schema error');

  console.log('whatsapp removal completeness db smoke: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
