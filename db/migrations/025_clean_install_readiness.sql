BEGIN;

-- This migration intentionally behaves differently ONLY when the migration
-- runner has positively identified a truly blank PostgreSQL database. The
-- transaction-local marker is set by scripts/migrate-db.js. Upgrades never
-- enter this branch, so existing plans/storefront configuration are preserved.
DO $$
BEGIN
    IF current_setting('steamfusion.fresh_install', true) = 'on' THEN
        -- Historical migrations seeded four CAPTAiNFiN example/commercial plans.
        -- A distributable installation must start with zero business objects.
        DELETE FROM plans
        WHERE code IN ('trial-24h','monthly','six-month','yearly');

        -- Historical storefront copy is useful for the original deployment but
        -- is not an appropriate business default for a clean/white-label install.
        DELETE FROM platform_settings
        WHERE setting_key IN ('storefront','storefront_features','admin_defaults','reseller_defaults');

        -- Safe first-run feature state. Everything customer-facing is opt-in.
        INSERT INTO platform_settings(setting_key,setting_value)
        VALUES (
            'platform',
            jsonb_build_object(
                'publicRegistration', false,
                'storefrontEnabled', false,
                'requireEmailVerification', false,
                'entitlementJobIntervalMs', 300000,
                'serverHealthIntervalMs', 300000,
                'overseerrUrl', ''
            )
        )
        ON CONFLICT(setting_key) DO UPDATE
        SET setting_value=EXCLUDED.setting_value,updated_at=NOW();

        INSERT INTO platform_settings(setting_key,setting_value)
        VALUES ('referral_program', jsonb_build_object('enabled',false,'rewardDays',7))
        ON CONFLICT(setting_key) DO UPDATE
        SET setting_value=EXCLUDED.setting_value,updated_at=NOW();

        INSERT INTO platform_settings(setting_key,setting_value)
        VALUES (
            'installation',
            jsonb_build_object(
                'cleanInstall', true,
                'setupVersion', 1,
                'createdAt', to_jsonb(NOW())
            )
        )
        ON CONFLICT(setting_key) DO NOTHING;
    END IF;
END $$;

COMMIT;
