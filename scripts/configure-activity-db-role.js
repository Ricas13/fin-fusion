'use strict';

require('dotenv').config();
const { getPool } = require('../src/db');

async function main() {
    const password = String(process.env.ACTIVITY_DB_PASSWORD || '');
    if (password.length < 24) throw new Error('ACTIVITY_DB_PASSWORD must be at least 24 characters');

    const pool = getPool();
    const client = await pool.connect();
    try {
        const required = await client.query(`
            SELECT to_regclass('public.active_playback_sessions') AS active,
                   to_regclass('public.playback_history') AS history,
                   to_regclass('public.stream_policy_events') AS events,
                   to_regclass('public.jellyfin_server_metrics') AS metrics
        `);
        if (!required.rows[0].active || !required.rows[0].history || !required.rows[0].events || !required.rows[0].metrics) {
            throw new Error('Run database migrations before configuring the activity role');
        }

        await client.query("SELECT set_config('steamfusion.activity_password',$1,false)", [password]);
        await client.query(`
            DO $role$
            DECLARE role_password text := current_setting('steamfusion.activity_password');
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='steamfusion_activity') THEN
                    CREATE ROLE steamfusion_activity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5;
                END IF;
                EXECUTE format('ALTER ROLE steamfusion_activity PASSWORD %L', role_password);
            END
            $role$;
        `);

        await client.query(`
            ALTER ROLE steamfusion_activity SET statement_timeout='15s';
            ALTER ROLE steamfusion_activity SET lock_timeout='5s';
            ALTER ROLE steamfusion_activity SET idle_in_transaction_session_timeout='15s';
            REVOKE ALL ON SCHEMA public FROM steamfusion_activity;
            GRANT USAGE ON SCHEMA public TO steamfusion_activity;
            REVOKE ALL ON ALL TABLES IN SCHEMA public FROM steamfusion_activity;
            REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM steamfusion_activity;

            GRANT SELECT (id,name,slug,server_class,base_url,public_url,enabled,priority,max_users,health_status,last_health_check,api_key_encrypted)
                ON jellyfin_servers TO steamfusion_activity;
            GRANT SELECT (id,customer_id,server_id,jellyfin_user_id,disabled)
                ON jellyfin_accounts TO steamfusion_activity;
            GRANT SELECT (id,customer_id,plan_id,status,current_period_end,created_at)
                ON subscriptions TO steamfusion_activity;
            GRANT SELECT (id,code,streams,active)
                ON plans TO steamfusion_activity;

            GRANT SELECT,INSERT,UPDATE,DELETE ON active_playback_sessions TO steamfusion_activity;
            GRANT SELECT,INSERT,UPDATE,DELETE ON playback_history TO steamfusion_activity;
            GRANT SELECT,INSERT,UPDATE,DELETE ON stream_policy_events TO steamfusion_activity;
            GRANT SELECT,INSERT,UPDATE ON jellyfin_server_metrics TO steamfusion_activity;
            GRANT USAGE,SELECT ON SEQUENCE playback_history_id_seq TO steamfusion_activity;
            GRANT USAGE,SELECT ON SEQUENCE stream_policy_events_id_seq TO steamfusion_activity;
        `);

        console.log('Configured steamfusion_activity with least-privilege grants');
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
