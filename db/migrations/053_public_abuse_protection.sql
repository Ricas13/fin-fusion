BEGIN;

INSERT INTO platform_settings(setting_key,setting_value)
VALUES('public_abuse_protection_v1',jsonb_build_object(
    'turnstileEnabled',false,
    'turnstileSiteKey','',
    'turnstileSecretEncrypted',NULL,
    'protectRegistration',true,
    'protectPasswordReset',true
)) ON CONFLICT(setting_key) DO NOTHING;

COMMIT;
