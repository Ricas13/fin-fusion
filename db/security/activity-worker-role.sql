\set ON_ERROR_STOP on
\getenv activity_password ACTIVITY_DB_PASSWORD

\if :{?activity_password}
\else
  \echo 'ACTIVITY_DB_PASSWORD is required'
  \quit 1
\endif

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfusion_activity') THEN
        CREATE ROLE steamfusion_activity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END
$$;

ALTER ROLE steamfusion_activity PASSWORD :'activity_password';
REVOKE ALL ON SCHEMA public FROM steamfusion_activity;
GRANT USAGE ON SCHEMA public TO steamfusion_activity;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM steamfusion_activity;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM steamfusion_activity;

GRANT SELECT ON jellyfin_servers,jellyfin_accounts,subscriptions,plans TO steamfusion_activity;

GRANT SELECT,INSERT,UPDATE,DELETE ON active_playback_sessions TO steamfusion_activity;
GRANT SELECT,INSERT,UPDATE,DELETE ON playback_history TO steamfusion_activity;
GRANT SELECT,INSERT,UPDATE,DELETE ON stream_policy_events TO steamfusion_activity;

GRANT USAGE,SELECT ON SEQUENCE playback_history_id_seq TO steamfusion_activity;
GRANT USAGE,SELECT ON SEQUENCE stream_policy_events_id_seq TO steamfusion_activity;
