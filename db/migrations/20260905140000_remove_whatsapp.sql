BEGIN;

-- WhatsApp has been retired from CAPTAiNFiN. Purge channel state and credentials,
-- while retaining legacy nullable columns for rollback/older-node compatibility.
DELETE FROM admin_notification_preferences WHERE channel='whatsapp';
DELETE FROM customer_notification_preferences WHERE channel='whatsapp';
DELETE FROM notification_outbox WHERE channel='whatsapp';

UPDATE notification_preferences SET whatsapp_enabled=FALSE WHERE whatsapp_enabled=TRUE;
UPDATE customer_communication_preferences SET phone_e164=NULL,whatsapp_opt_in=FALSE,whatsapp_opted_in_at=NULL WHERE phone_e164 IS NOT NULL OR whatsapp_opt_in=TRUE OR whatsapp_opted_in_at IS NOT NULL;
UPDATE admin_communication_preferences SET phone_e164=NULL,whatsapp_opt_in=FALSE,whatsapp_opted_in_at=NULL WHERE phone_e164 IS NOT NULL OR whatsapp_opt_in=TRUE OR whatsapp_opted_in_at IS NOT NULL;

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
