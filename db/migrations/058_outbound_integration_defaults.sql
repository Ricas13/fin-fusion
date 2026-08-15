BEGIN;

-- New installations should not be able to point server-side integrations at
-- arbitrary private/LAN destinations unless an administrator opts in. Existing
-- installations predate this control and may legitimately use Docker/LAN
-- Jellyfin endpoints, so preserve compatibility for upgrades that have no
-- explicit value yet. Once present, the administrator's explicit choice wins.
UPDATE platform_settings
SET setting_value = setting_value || jsonb_build_object(
        'allowPrivateIntegrations',
        CASE
            WHEN setting_value ? 'allowPrivateIntegrations'
                THEN COALESCE((setting_value->>'allowPrivateIntegrations')::boolean,FALSE)
            WHEN current_setting('steamfusion.fresh_install',true)='on'
                THEN FALSE
            ELSE TRUE
        END,
        'outboundTrustedHosts',
        CASE
            WHEN jsonb_typeof(setting_value->'outboundTrustedHosts')='array'
                THEN setting_value->'outboundTrustedHosts'
            ELSE '[]'::jsonb
        END
    ),
    updated_at=NOW()
WHERE setting_key='operations_v1';

COMMIT;
