BEGIN;

CREATE TABLE IF NOT EXISTS jellyfin_activity_poll_state (
    server_id uuid PRIMARY KEY REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    last_attempt_at timestamp with time zone NOT NULL,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jellyfin_activity_poll_state_success_idx
    ON jellyfin_activity_poll_state(last_success_at DESC);

CREATE OR REPLACE FUNCTION public.activity_grace_seconds()
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    configured integer;
BEGIN
    SELECT NULLIF(setting_value->>'graceSeconds','')::integer
      INTO configured
      FROM platform_settings
     WHERE setting_key='stream_policy_v1';
    RETURN GREATEST(10, LEAST(900, COALESCE(configured,45)));
EXCEPTION WHEN OTHERS THEN
    RETURN 45;
END;
$$;

CREATE OR REPLACE FUNCTION public.playback_history_not_seen_grace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    observed_at timestamp with time zone;
    grace_seconds integer;
BEGIN
    IF NEW.ended_reason IS DISTINCT FROM 'not_seen' OR OLD.ended_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT last_seen_at INTO observed_at
      FROM active_playback_sessions
     WHERE server_id=OLD.server_id AND playback_key=OLD.playback_key
     LIMIT 1;

    IF observed_at IS NULL THEN
        observed_at := OLD.last_seen_at;
    END IF;
    grace_seconds := public.activity_grace_seconds();

    IF observed_at > NOW() - (grace_seconds * INTERVAL '1 second') THEN
        NEW.ended_at := OLD.ended_at;
        NEW.ended_reason := OLD.ended_reason;
        NEW.last_seen_at := OLD.last_seen_at;
        RETURN NEW;
    END IF;

    -- A disappeared poll session closes at the last time Jellyfin actually
    -- reported it, not at the later grace-expiry check. This avoids inventing
    -- extra watched seconds while still tolerating one or two missed polls.
    NEW.ended_at := COALESCE(OLD.ended_at, observed_at, OLD.last_seen_at);
    NEW.last_seen_at := GREATEST(OLD.last_seen_at, COALESCE(observed_at, OLD.last_seen_at));
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS playback_history_not_seen_grace_trigger ON playback_history;
CREATE TRIGGER playback_history_not_seen_grace_trigger
BEFORE UPDATE OF ended_at,ended_reason,last_seen_at ON playback_history
FOR EACH ROW EXECUTE FUNCTION public.playback_history_not_seen_grace();

CREATE OR REPLACE FUNCTION public.active_playback_delete_grace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    grace_seconds integer;
    still_open boolean;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM playback_history
         WHERE server_id=OLD.server_id AND playback_key=OLD.playback_key AND ended_at IS NULL
    ) INTO still_open;
    IF NOT still_open THEN
        RETURN OLD;
    END IF;

    grace_seconds := public.activity_grace_seconds();
    IF OLD.last_seen_at > NOW() - (grace_seconds * INTERVAL '1 second') THEN
        RETURN NULL;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS active_playback_delete_grace_trigger ON active_playback_sessions;
CREATE TRIGGER active_playback_delete_grace_trigger
BEFORE DELETE ON active_playback_sessions
FOR EACH ROW EXECUTE FUNCTION public.active_playback_delete_grace();

COMMIT;
