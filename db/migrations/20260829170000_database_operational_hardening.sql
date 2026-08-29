BEGIN;

INSERT INTO platform_settings(setting_key,setting_value,updated_at)
VALUES(
    'data_retention_v1',
    '{"enabled":true,"batchSize":500,"classes":{"playbackHistoryDays":180,"securityEventDays":365,"auditLogDays":730,"paymentEventDays":365,"providerOperationDays":365,"notificationHistoryDays":90,"networkEventDays":90,"streamPolicyEventDays":90,"provisioningRunDays":180,"downloadEventDays":180,"stremioAttributionDays":180}}'::jsonb,
    NOW()
)
ON CONFLICT(setting_key) DO NOTHING;

-- Retention predicates are deliberately index-backed and terminal-state-only.
CREATE INDEX IF NOT EXISTS playback_history_ended_retention_idx
    ON playback_history(ended_at,id) WHERE ended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_created_retention_idx
    ON audit_log(created_at,id);
CREATE INDEX IF NOT EXISTS payment_events_processed_retention_idx
    ON payment_events(processed_at,id) WHERE processed_at IS NOT NULL AND processing_error IS NULL;
CREATE INDEX IF NOT EXISTS provider_operations_terminal_retention_idx
    ON provider_operations(updated_at,id) WHERE state IN ('reconciled','compensated');
CREATE INDEX IF NOT EXISTS notification_outbox_terminal_retention_idx
    ON notification_outbox(updated_at,id) WHERE status IN ('sent','cancelled');
CREATE INDEX IF NOT EXISTS access_network_events_retention_idx
    ON access_network_events(created_at,id);
CREATE INDEX IF NOT EXISTS stream_policy_events_retention_idx
    ON stream_policy_events(created_at,id);
CREATE INDEX IF NOT EXISTS provisioning_runs_retention_idx
    ON provisioning_runs(completed_at,id) WHERE status='succeeded' AND completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_download_events_retention_idx
    ON customer_download_events(created_at,id);
CREATE INDEX IF NOT EXISTS stremio_stream_attribution_retention_idx
    ON stremio_stream_attribution(requested_at,id);

CREATE OR REPLACE FUNCTION public.run_data_retention_batch(
    p_class TEXT,
    p_cutoff TIMESTAMPTZ,
    p_limit INTEGER DEFAULT 500
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit,500),1),1000);
    v_deleted INTEGER := 0;
BEGIN
    IF p_cutoff IS NULL THEN
        RAISE EXCEPTION 'retention cutoff is required';
    END IF;

    CASE p_class
        WHEN 'playback_history' THEN
            WITH doomed AS (
                SELECT id FROM playback_history
                WHERE ended_at IS NOT NULL AND ended_at < p_cutoff
                ORDER BY ended_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM playback_history t USING doomed d WHERE t.id=d.id;

        WHEN 'auth_events' THEN
            WITH doomed AS (
                SELECT id FROM auth_events
                WHERE created_at < p_cutoff
                ORDER BY created_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM auth_events t USING doomed d WHERE t.id=d.id;

        WHEN 'audit_log' THEN
            PERFORM set_config('steamfusion.allow_audit_mutation','on',true);
            WITH doomed AS (
                SELECT id FROM audit_log
                WHERE created_at < p_cutoff
                  AND action <> 'data.retention.batch'
                ORDER BY created_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM audit_log t USING doomed d WHERE t.id=d.id;

        WHEN 'payment_events' THEN
            WITH doomed AS (
                SELECT id FROM payment_events
                WHERE processed_at IS NOT NULL
                  AND processing_error IS NULL
                  AND processed_at < p_cutoff
                ORDER BY processed_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM payment_events t USING doomed d WHERE t.id=d.id;

        WHEN 'provider_operations' THEN
            WITH doomed AS (
                SELECT id FROM provider_operations
                WHERE state IN ('reconciled','compensated')
                  AND updated_at < p_cutoff
                ORDER BY updated_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM provider_operations t USING doomed d WHERE t.id=d.id;

        WHEN 'notification_outbox' THEN
            WITH doomed AS (
                SELECT id FROM notification_outbox
                WHERE status IN ('sent','cancelled')
                  AND updated_at < p_cutoff
                ORDER BY updated_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM notification_outbox t USING doomed d WHERE t.id=d.id;

        WHEN 'access_network_events' THEN
            WITH doomed AS (
                SELECT id FROM access_network_events
                WHERE created_at < p_cutoff
                ORDER BY created_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM access_network_events t USING doomed d WHERE t.id=d.id;

        WHEN 'stream_policy_events' THEN
            WITH doomed AS (
                SELECT id FROM stream_policy_events
                WHERE created_at < p_cutoff
                ORDER BY created_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM stream_policy_events t USING doomed d WHERE t.id=d.id;

        WHEN 'provisioning_runs' THEN
            WITH doomed AS (
                SELECT id FROM provisioning_runs
                WHERE status='succeeded' AND completed_at IS NOT NULL AND completed_at < p_cutoff
                ORDER BY completed_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM provisioning_runs t USING doomed d WHERE t.id=d.id;

        WHEN 'customer_download_events' THEN
            WITH doomed AS (
                SELECT id FROM customer_download_events
                WHERE created_at < p_cutoff
                ORDER BY created_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM customer_download_events t USING doomed d WHERE t.id=d.id;

        WHEN 'stremio_stream_attribution' THEN
            WITH doomed AS (
                SELECT id FROM stremio_stream_attribution
                WHERE requested_at < p_cutoff
                ORDER BY requested_at,id LIMIT v_limit
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM stremio_stream_attribution t USING doomed d WHERE t.id=d.id;

        ELSE
            RAISE EXCEPTION 'unsupported retention class: %', p_class;
    END CASE;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
    VALUES(NULL,'data.retention.batch','data_retention',p_class,
        jsonb_build_object('class',p_class,'cutoff',p_cutoff,'batchLimit',v_limit,'deleted',v_deleted));
    RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_access_network_leases(
    p_limit INTEGER DEFAULT 500
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit,500),1),1000);
    v_deleted INTEGER := 0;
BEGIN
    WITH doomed AS (
        SELECT id FROM access_network_leases
        WHERE expires_at < NOW()
        ORDER BY expires_at,id LIMIT v_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM access_network_leases t USING doomed d WHERE t.id=d.id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted > 0 THEN
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES(NULL,'data.retention.network_leases','data_retention','access_network_leases',
            jsonb_build_object('batchLimit',v_limit,'deleted',v_deleted));
    END IF;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.run_data_retention_batch(TEXT,TIMESTAMPTZ,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_expired_access_network_leases(INTEGER) FROM PUBLIC;

COMMENT ON FUNCTION public.run_data_retention_batch(TEXT,TIMESTAMPTZ,INTEGER) IS
    'Canonical bounded retention owner. Only terminal/finished records are eligible; financial ledgers, incidents, subscriptions and unfinished provider/payment state are intentionally excluded.';
COMMENT ON FUNCTION public.cleanup_expired_access_network_leases(INTEGER) IS
    'Canonical bounded housekeeping for expired household/network leases; does not alter admission policy.';

COMMIT;
