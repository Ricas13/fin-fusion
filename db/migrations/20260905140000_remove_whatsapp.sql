BEGIN;

-- WhatsApp has been retired from CAPTAiNFiN. Remove persisted channel state,
-- credentials, schema columns and channel allowances so no live WhatsApp
-- contract remains after this migration.
DELETE FROM admin_notification_preferences WHERE channel='whatsapp';
DELETE FROM customer_notification_preferences WHERE channel='whatsapp';
DELETE FROM notification_outbox WHERE channel='whatsapp';

ALTER TABLE admin_notification_preferences
  DROP CONSTRAINT IF EXISTS admin_notification_preferences_channel_check;
ALTER TABLE admin_notification_preferences
  ADD CONSTRAINT admin_notification_preferences_channel_check
  CHECK (channel = ANY (ARRAY['email'::text,'telegram'::text,'discord'::text]));

ALTER TABLE customer_notification_preferences
  DROP CONSTRAINT IF EXISTS customer_notification_preferences_channel_check;
ALTER TABLE customer_notification_preferences
  ADD CONSTRAINT customer_notification_preferences_channel_check
  CHECK (channel = ANY (ARRAY['telegram'::text,'discord'::text]));

ALTER TABLE notification_outbox
  DROP CONSTRAINT IF EXISTS notification_outbox_channel_check;
ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_channel_check
  CHECK (channel = ANY (ARRAY['email'::text,'telegram'::text,'webhook'::text,'discord'::text]));

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

UPDATE platform_settings
SET setting_value = setting_value
  - 'whatsappEnabled'
  - 'whatsappTokenEncrypted'
  - 'whatsappPhoneNumberId'
  - 'whatsappTemplateName'
  - 'whatsappTemplateLanguage'
  - 'whatsapp'
WHERE setting_key IN ('notification_delivery_v1','notification_channels_v1');

COMMIT;
