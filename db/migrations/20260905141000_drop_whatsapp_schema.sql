BEGIN;

-- Follow-up to 20260905140000_remove_whatsapp.sql. The first migration was
-- intentionally rolling-deploy safe and scrubbed all WhatsApp state while
-- retaining nullable legacy columns. Runtime/UI support is now gone, so remove
-- those columns as a distinct migration that will also run on installations
-- which have already applied the original retirement migration.
ALTER TABLE notification_preferences
  DROP COLUMN IF EXISTS whatsapp_enabled;

ALTER TABLE customer_communication_preferences
  DROP COLUMN IF EXISTS whatsapp_opted_in_at,
  DROP COLUMN IF EXISTS whatsapp_opt_in,
  DROP COLUMN IF EXISTS phone_e164;

ALTER TABLE admin_communication_preferences
  DROP COLUMN IF EXISTS whatsapp_opted_in_at,
  DROP COLUMN IF EXISTS whatsapp_opt_in,
  DROP COLUMN IF EXISTS phone_e164;

COMMIT;
