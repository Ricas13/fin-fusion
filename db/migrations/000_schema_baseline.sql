--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: assign_native_staff_compatibility_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_native_staff_compatibility_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.role='admin' AND NEW.legacy_numeric_id IS NULL THEN
        NEW.legacy_numeric_id := -nextval('native_staff_legacy_compat_seq');
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: bind_legacy_provider_mapping_price(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bind_legacy_provider_mapping_price() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    selected_price UUID;
    selected_currency CHAR(3);
    selected_minor INTEGER;
BEGIN
    IF NEW.plan_price_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT pr.id INTO selected_price
    FROM plan_prices pr
    WHERE pr.plan_id=NEW.plan_id
    ORDER BY pr.is_default DESC, pr.active DESC, pr.created_at ASC
    LIMIT 1;

    IF selected_price IS NULL THEN
        SELECT
            CASE
                WHEN UPPER(COALESCE(p.currency,'GBP')) IN ('GBP','USD','EUR')
                    THEN UPPER(COALESCE(p.currency,'GBP'))::CHAR(3)
                ELSE 'GBP'::CHAR(3)
            END,
            GREATEST(0,COALESCE(p.price_minor,0))
        INTO selected_currency, selected_minor
        FROM plans p
        WHERE p.id=NEW.plan_id;

        IF selected_currency IS NULL THEN
            RAISE EXCEPTION 'Provider mapping references unknown plan %', NEW.plan_id;
        END IF;

        INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default)
        VALUES(NEW.plan_id,selected_currency,selected_minor,TRUE,TRUE)
        ON CONFLICT(plan_id,currency) DO UPDATE
            SET updated_at=plan_prices.updated_at
        RETURNING id INTO selected_price;
    END IF;

    NEW.plan_price_id := selected_price;
    RETURN NEW;
END;
$$;


--
-- Name: enforce_single_live_customer_recurring_subscription(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_single_live_customer_recurring_subscription() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    new_is_addon BOOLEAN := FALSE;
BEGIN
    IF NEW.source IN ('stripe','paypal')
       AND NEW.status IN ('active','trialing','past_due','paused')
       AND NEW.current_period_end > NOW()
       AND ((NEW.source='stripe' AND LEFT(COALESCE(NEW.provider_subscription_id,''),4)='sub_')
         OR (NEW.source='paypal' AND LEFT(COALESCE(NEW.provider_subscription_id,''),2)='I-')) THEN

        SELECT COALESCE(is_addon,FALSE) INTO new_is_addon
          FROM plans WHERE id=NEW.plan_id;

        IF new_is_addon THEN
            IF EXISTS (
                SELECT 1 FROM subscriptions s
                WHERE s.customer_id=NEW.customer_id
                  AND s.id<>NEW.id
                  AND s.plan_id=NEW.plan_id
                  AND s.superseded_by IS NULL
                  AND s.source IN ('stripe','paypal')
                  AND s.status IN ('active','trialing','past_due','paused')
                  AND s.current_period_end>NOW()
                  AND ((s.source='stripe' AND LEFT(COALESCE(s.provider_subscription_id,''),4)='sub_')
                    OR (s.source='paypal' AND LEFT(COALESCE(s.provider_subscription_id,''),2)='I-'))
            ) THEN
                RAISE EXCEPTION 'Customer already has a live recurring subscription for this add-on';
            END IF;
        ELSIF EXISTS (
            SELECT 1 FROM subscriptions s
            JOIN plans existing_plan ON existing_plan.id=s.plan_id
            WHERE s.customer_id=NEW.customer_id
              AND s.id<>NEW.id
              AND COALESCE(existing_plan.is_addon,FALSE)=FALSE
              AND s.superseded_by IS NULL
              AND s.source IN ('stripe','paypal')
              AND s.status IN ('active','trialing','past_due','paused')
              AND s.current_period_end>NOW()
              AND ((s.source='stripe' AND LEFT(COALESCE(s.provider_subscription_id,''),4)='sub_')
                OR (s.source='paypal' AND LEFT(COALESCE(s.provider_subscription_id,''),2)='I-'))
        ) THEN
            RAISE EXCEPTION 'Customer already has a live recurring primary provider subscription';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: enforce_stremio_entitlement_integrity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_stremio_entitlement_integrity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  sub_customer UUID;
  sub_service TEXT;
  sub_plan UUID;
  account_customer UUID;
  account_server UUID;
  account_purpose_value TEXT;
  server_allowed BOOLEAN;
  shared_sources BOOLEAN;
BEGIN
  SELECT customer_id,COALESCE(service_type_snapshot,'jellyfin'),plan_id
    INTO sub_customer,sub_service,sub_plan FROM subscriptions WHERE id=NEW.subscription_id;
  IF sub_customer IS NULL OR sub_customer<>NEW.customer_id THEN RAISE EXCEPTION 'Stremio subscription/customer mismatch'; END IF;
  IF sub_service NOT IN ('stremio','bundle') THEN RAISE EXCEPTION 'Stremio entitlement requires a stremio or bundle subscription'; END IF;

  SELECT EXISTS(SELECT 1 FROM plan_stremio_sources WHERE plan_id=sub_plan AND enabled=TRUE) INTO shared_sources;

  IF NEW.status<>'revoked' AND NEW.server_id IS NOT NULL THEN
    SELECT stremio_enabled INTO server_allowed FROM jellyfin_servers WHERE id=NEW.server_id;
    IF COALESCE(server_allowed,FALSE)=FALSE THEN RAISE EXCEPTION 'Assigned Jellyfin server is not enabled for Stremio'; END IF;
  END IF;

  IF NEW.jellyfin_account_id IS NOT NULL THEN
    SELECT customer_id,server_id,account_purpose INTO account_customer,account_server,account_purpose_value FROM jellyfin_accounts WHERE id=NEW.jellyfin_account_id;
    IF account_customer IS NULL OR account_customer<>NEW.customer_id OR account_server IS DISTINCT FROM NEW.server_id THEN RAISE EXCEPTION 'Stremio Jellyfin account ownership/server mismatch'; END IF;
    IF account_purpose_value<>'stremio_internal' THEN RAISE EXCEPTION 'Stremio entitlement requires a dedicated internal Jellyfin account'; END IF;
  END IF;

  IF NEW.status='active' AND NEW.token_hash IS NULL THEN RAISE EXCEPTION 'Active Stremio entitlement requires an install credential'; END IF;
  IF NEW.status='active' AND NOT shared_sources AND (NEW.server_id IS NULL OR NEW.jellyfin_account_id IS NULL OR NEW.jellyfin_access_token_encrypted IS NULL) THEN
    RAISE EXCEPTION 'Active Stremio entitlement requires either selected shared sources or a managed Jellyfin delivery identity';
  END IF;
  IF NEW.status='active' AND shared_sources AND ((NEW.server_id IS NULL) <> (NEW.jellyfin_account_id IS NULL)) THEN
    RAISE EXCEPTION 'Managed Jellyfin delivery identity must be complete when attached to a shared-source entitlement';
  END IF;
  IF NEW.status='revoked' AND NEW.revoked_at IS NULL THEN NEW.revoked_at:=NOW(); ELSIF NEW.status<>'revoked' THEN NEW.revoked_at:=NULL; END IF;
  NEW.updated_at:=NOW();RETURN NEW;
END;
$$;


--
-- Name: ensure_plan_default_price_after_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_plan_default_price_after_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    selected_currency CHAR(3);
BEGIN
    selected_currency := CASE
        WHEN UPPER(COALESCE(NEW.currency, 'GBP')) IN ('GBP','USD','EUR')
            THEN UPPER(COALESCE(NEW.currency, 'GBP'))::CHAR(3)
        ELSE 'GBP'::CHAR(3)
    END;

    INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default)
    VALUES(NEW.id,selected_currency,GREATEST(0,COALESCE(NEW.price_minor,0)),TRUE,TRUE)
    ON CONFLICT(plan_id,currency) DO NOTHING;

    RETURN NEW;
END;
$$;


--
-- Name: mark_fresh_jellyfin_password_setup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_fresh_jellyfin_password_setup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.last_policy_sync IS NOT NULL THEN
        NEW.password_setup_required := TRUE;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: protect_audit_log_history(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_audit_log_history() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF current_setting('steamfusion.allow_audit_mutation',true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'audit_log is append-only';
    END IF;
    RETURN COALESCE(NEW,OLD);
END;
$$;


--
-- Name: protect_canonical_free_tier(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_canonical_free_tier() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        IF OLD.is_free_tier=TRUE THEN
            RAISE EXCEPTION 'The canonical free plan cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.is_free_tier=TRUE THEN
        IF NEW.is_free_tier<>TRUE
           OR NEW.active<>TRUE
           OR NEW.visible<>TRUE
           OR NEW.archived_at IS NOT NULL
           OR NEW.price_minor<>0
           OR NEW.billing_interval='trial' THEN
            RAISE EXCEPTION 'The canonical free plan must remain active, visible, non-trial and free';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: protect_canonical_free_tier_price(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_canonical_free_tier_price() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE free_plan BOOLEAN;
BEGIN
    SELECT is_free_tier INTO free_plan FROM plans WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.plan_id ELSE NEW.plan_id END;
    IF free_plan=TRUE THEN
        IF TG_OP='DELETE' THEN
            RAISE EXCEPTION 'Free-tier storefront prices cannot be deleted';
        END IF;
        IF NEW.price_minor<>0 OR NEW.active<>TRUE THEN
            RAISE EXCEPTION 'Free-tier storefront prices must remain active and zero';
        END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;


--
-- Name: reset_direct_provider_mapping_validation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_direct_provider_mapping_validation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='INSERT' OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.external_id IS DISTINCT FROM OLD.external_id
       OR NEW.checkout_mode IS DISTINCT FROM OLD.checkout_mode THEN
        NEW.validation_state := 'unverified';
        NEW.validated_at := NULL;
        NEW.validation_error := NULL;
        NEW.validated_external_snapshot := '{}'::jsonb;
    END IF;
    RETURN NEW;
END $$;


--
-- Name: snapshot_subscription_multicurrency_contract(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapshot_subscription_multicurrency_contract() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    price_text TEXT;
    mapping_text TEXT;
BEGIN
    IF NEW.commercial_snapshot IS NOT NULL AND jsonb_typeof(NEW.commercial_snapshot)='object' THEN
        price_text := NEW.commercial_snapshot->>'planPriceId';
        mapping_text := NEW.commercial_snapshot->>'providerMappingRecordId';
        IF NEW.plan_price_id_snapshot IS NULL AND price_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
            NEW.plan_price_id_snapshot := price_text::uuid;
        END IF;
        IF NEW.provider_mapping_id_snapshot IS NULL AND mapping_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
            NEW.provider_mapping_id_snapshot := mapping_text::uuid;
        END IF;
        NEW.provider_mapping_external_id_snapshot := COALESCE(
            NEW.provider_mapping_external_id_snapshot,
            NULLIF(NEW.commercial_snapshot->>'providerMappingId',''),
            NEW.provider_price_id_snapshot
        );
    END IF;
    RETURN NEW;
END;
$_$;


--
-- Name: snapshot_subscription_plan_terms(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapshot_subscription_plan_terms() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p plans%ROWTYPE;
BEGIN
    IF TG_OP='INSERT' THEN
        SELECT * INTO p FROM plans WHERE id=NEW.plan_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
        NEW.plan_name_snapshot := COALESCE(NEW.plan_name_snapshot,p.name);
        NEW.plan_code_snapshot := COALESCE(NEW.plan_code_snapshot,p.code);
        NEW.price_minor_snapshot := COALESCE(NEW.price_minor_snapshot,p.price_minor);
        NEW.currency_snapshot := COALESCE(NEW.currency_snapshot,p.currency);
        NEW.billing_interval_snapshot := COALESCE(NEW.billing_interval_snapshot,p.billing_interval);
        NEW.duration_days_snapshot := COALESCE(NEW.duration_days_snapshot,p.duration_days);
        NEW.service_type_snapshot := COALESCE(NEW.service_type_snapshot,p.service_type);
    ELSIF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
        SELECT * INTO p FROM plans WHERE id=NEW.plan_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
        IF NEW.plan_name_snapshot IS NOT DISTINCT FROM OLD.plan_name_snapshot THEN NEW.plan_name_snapshot := p.name; END IF;
        IF NEW.plan_code_snapshot IS NOT DISTINCT FROM OLD.plan_code_snapshot THEN NEW.plan_code_snapshot := p.code; END IF;
        IF NEW.price_minor_snapshot IS NOT DISTINCT FROM OLD.price_minor_snapshot THEN NEW.price_minor_snapshot := p.price_minor; END IF;
        IF NEW.currency_snapshot IS NOT DISTINCT FROM OLD.currency_snapshot THEN NEW.currency_snapshot := p.currency; END IF;
        IF NEW.billing_interval_snapshot IS NOT DISTINCT FROM OLD.billing_interval_snapshot THEN NEW.billing_interval_snapshot := p.billing_interval; END IF;
        IF NEW.duration_days_snapshot IS NOT DISTINCT FROM OLD.duration_days_snapshot THEN NEW.duration_days_snapshot := p.duration_days; END IF;
        IF NEW.service_type_snapshot IS NOT DISTINCT FROM OLD.service_type_snapshot THEN NEW.service_type_snapshot := p.service_type; END IF;
    END IF;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_activation_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_activation_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    token_encrypted text NOT NULL,
    purpose text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_type text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT account_tokens_token_type_check CHECK ((token_type = ANY (ARRAY['email_verify'::text, 'password_reset'::text, 'email_change'::text])))
);


--
-- Name: active_playback_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_playback_sessions (
    server_id uuid NOT NULL,
    jellyfin_session_id text NOT NULL,
    playback_key text NOT NULL,
    customer_id uuid,
    jellyfin_account_id uuid,
    jellyfin_user_id text,
    play_session_id text,
    item_id text,
    item_name text,
    item_type text,
    client_name text,
    device_name text,
    application_version text,
    remote_endpoint_encrypted text,
    playback_method text DEFAULT 'unknown'::text NOT NULL,
    transcode_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_paused boolean DEFAULT false NOT NULL,
    position_ticks bigint,
    last_activity_at timestamp with time zone,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    stream_limit integer,
    over_limit_confirmations integer DEFAULT 0 NOT NULL,
    CONSTRAINT active_playback_sessions_playback_method_check CHECK ((playback_method = ANY (ARRAY['directplay'::text, 'directstream'::text, 'transcode'::text, 'unknown'::text])))
);


--
-- Name: admin_channel_link_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_channel_link_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_user_id uuid NOT NULL,
    channel text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_channel_link_tokens_channel_check CHECK ((channel = ANY (ARRAY['telegram'::text, 'discord'::text])))
);


--
-- Name: admin_communication_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_communication_preferences (
    admin_user_id uuid NOT NULL,
    telegram_chat_id text,
    telegram_handle text,
    telegram_linked_at timestamp with time zone,
    discord_user_id text,
    discord_handle text,
    discord_linked_at timestamp with time zone,
    phone_e164 text,
    whatsapp_opt_in boolean DEFAULT false NOT NULL,
    whatsapp_opted_in_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_nav_read_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_nav_read_state (
    admin_user_id uuid NOT NULL,
    nav_key text NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notification_preferences (
    admin_user_id uuid NOT NULL,
    event_type text NOT NULL,
    channel text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_notification_preferences_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'telegram'::text, 'discord'::text, 'whatsapp'::text])))
);


--
-- Name: affiliate_credit_checkout_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_credit_checkout_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    checkout_intent_id uuid NOT NULL,
    currency character(3) NOT NULL,
    amount_minor integer NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    applied_at timestamp with time zone,
    released_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT affiliate_credit_checkout_reservations_amount_minor_check CHECK ((amount_minor > 0)),
    CONSTRAINT affiliate_credit_checkout_reservations_currency_check CHECK ((currency = ANY (ARRAY['GBP'::bpchar, 'USD'::bpchar, 'EUR'::bpchar]))),
    CONSTRAINT affiliate_credit_checkout_reservations_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'applied'::text, 'released'::text])))
);


--
-- Name: affiliate_credit_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_credit_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    currency character(3) NOT NULL,
    amount_minor integer NOT NULL,
    entry_type text NOT NULL,
    state text DEFAULT 'available'::text NOT NULL,
    referral_redemption_id uuid,
    referred_customer_id uuid,
    qualifying_subscription_id uuid,
    applied_subscription_id uuid,
    payment_incident_id uuid,
    available_at timestamp with time zone,
    reference_id text,
    note text DEFAULT ''::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT affiliate_credit_ledger_amount_minor_check CHECK ((amount_minor <> 0)),
    CONSTRAINT affiliate_credit_ledger_currency_check CHECK ((currency = ANY (ARRAY['GBP'::bpchar, 'USD'::bpchar, 'EUR'::bpchar]))),
    CONSTRAINT affiliate_credit_ledger_entry_type_check CHECK ((entry_type = ANY (ARRAY['earned'::text, 'redeemed'::text, 'reversed'::text, 'adjustment'::text]))),
    CONSTRAINT affiliate_credit_ledger_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'available'::text, 'void'::text])))
);


--
-- Name: affiliate_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_profiles (
    customer_id uuid NOT NULL,
    active boolean DEFAULT true NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    note text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text,
    username text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    totp_enabled boolean DEFAULT false NOT NULL,
    totp_secret_encrypted text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email_verified_at timestamp with time zone,
    last_login_at timestamp with time zone,
    legacy_numeric_id integer,
    password_changed_at timestamp with time zone,
    failed_login_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    totp_enrolled_at timestamp with time zone,
    session_version integer DEFAULT 1 NOT NULL,
    pending_email text,
    pending_email_requested_at timestamp with time zone,
    preferred_currency character(3),
    CONSTRAINT app_users_preferred_currency_check CHECK (((preferred_currency IS NULL) OR (preferred_currency = ANY (ARRAY['GBP'::bpchar, 'USD'::bpchar, 'EUR'::bpchar])))),
    CONSTRAINT app_users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'customer'::text])))
);


--
-- Name: arr_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.arr_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    kind text NOT NULL,
    base_url text NOT NULL,
    api_key_encrypted text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    health_status text DEFAULT 'unknown'::text NOT NULL,
    version text,
    last_health_check timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT arr_instances_health_status_check CHECK ((health_status = ANY (ARRAY['unknown'::text, 'healthy'::text, 'degraded'::text, 'offline'::text]))),
    CONSTRAINT arr_instances_kind_check CHECK ((kind = ANY (ARRAY['radarr'::text, 'sonarr'::text])))
);


--
-- Name: attention_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attention_state (
    item_key text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_to uuid,
    note text,
    acknowledged_at timestamp with time zone,
    acknowledged_by uuid,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attention_state_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'resolved'::text, 'ignored'::text])))
);


--
-- Name: attention_workflow; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attention_workflow (
    fingerprint text NOT NULL,
    category text NOT NULL,
    severity text NOT NULL,
    title text NOT NULL,
    href text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    acknowledged_by uuid,
    assigned_to uuid,
    note text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attention_workflow_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    actor_user_id uuid,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: auth_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_events (
    id bigint NOT NULL,
    user_id uuid,
    identity_hint text,
    event_type text NOT NULL,
    success boolean DEFAULT false NOT NULL,
    ip_encrypted text,
    user_agent_hash text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_events_id_seq OWNED BY public.auth_events.id;


--
-- Name: auth_recovery_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_recovery_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    session_id text NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    session_version integer NOT NULL,
    ip_encrypted text,
    user_agent_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: auth_totp_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_totp_enrollments (
    user_id uuid NOT NULL,
    secret_encrypted text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: automation_job_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_job_state (
    job_key text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    interval_seconds integer NOT NULL,
    last_started_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_error text,
    last_duration_ms integer,
    last_processed_count integer,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    next_run_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    force_run_requested boolean DEFAULT false NOT NULL,
    CONSTRAINT automation_job_state_interval_seconds_check CHECK (((interval_seconds >= 30) AND (interval_seconds <= 86400)))
);


--
-- Name: background_job_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.background_job_items (
    id bigint NOT NULL,
    job_id uuid NOT NULL,
    customer_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    previous_state jsonb,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    claim_token uuid,
    CONSTRAINT background_job_items_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: background_job_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.background_job_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: background_job_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.background_job_items_id_seq OWNED BY public.background_job_items.id;


--
-- Name: background_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.background_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by uuid,
    idempotency_key text,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    total_items integer DEFAULT 0 NOT NULL,
    succeeded_items integer DEFAULT 0 NOT NULL,
    failed_items integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT background_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'completed_with_errors'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: backup_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    backup_type text DEFAULT 'database'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    file_name text,
    file_path text,
    size_bytes bigint,
    checksum_sha256 text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    verified_at timestamp with time zone,
    verification_note text,
    error text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT backup_runs_backup_type_check CHECK ((backup_type = 'database'::text)),
    CONSTRAINT backup_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'deleted'::text])))
);


--
-- Name: backup_verification_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_verification_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    backup_run_id uuid NOT NULL,
    requested_by uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    worker_instance_id text,
    error text,
    CONSTRAINT backup_verification_requests_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: backup_worker_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_worker_state (
    worker_key text DEFAULT 'database_backup'::text NOT NULL,
    instance_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_error text,
    next_run_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: billing_checkout_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_checkout_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text NOT NULL,
    customer_id uuid,
    plan_id uuid,
    tier_id uuid,
    provider text NOT NULL,
    checkout_mode text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    nonce_hash text NOT NULL,
    provider_checkout_id text,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    commercial_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    plan_price_id uuid,
    CONSTRAINT billing_checkout_intents_checkout_mode_check CHECK ((checkout_mode = ANY (ARRAY['payment'::text, 'subscription'::text]))),
    CONSTRAINT billing_checkout_intents_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text]))),
    CONSTRAINT billing_checkout_intents_state_check CHECK ((state = ANY (ARRAY['open'::text, 'completed'::text, 'cancelled'::text, 'expired'::text, 'failed'::text])))
);


--
-- Name: branding_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branding_assets (
    kind text NOT NULL,
    mime_type text NOT NULL,
    file_ext text NOT NULL,
    content bytea NOT NULL,
    size_bytes integer NOT NULL,
    sha256 text NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT branding_assets_kind_check CHECK ((kind = ANY (ARRAY['logo'::text, 'favicon'::text]))),
    CONSTRAINT branding_assets_size_bytes_check CHECK ((size_bytes > 0))
);


--
-- Name: content_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid,
    media_type text,
    title text,
    external_id text,
    request_text text,
    status text DEFAULT 'pending'::text NOT NULL,
    admin_response text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    tmdb_id integer,
    tvdb_id integer,
    year integer,
    poster_path text,
    backdrop_path text,
    quality_tier_id uuid,
    arr_instance_id uuid,
    arr_item_id integer,
    routed_at timestamp with time zone,
    last_status_check timestamp with time zone,
    available_at timestamp with time zone,
    last_error text,
    CONSTRAINT content_requests_media_type_check CHECK ((media_type = ANY (ARRAY['movie'::text, 'series'::text, 'other'::text]))),
    CONSTRAINT content_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'added'::text, 'declined'::text, 'searching'::text, 'available'::text, 'failed'::text])))
);


--
-- Name: customer_access_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_access_holds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    hold_type text NOT NULL,
    source_key text DEFAULT ''::text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    released_by uuid
);


--
-- Name: customer_account_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_account_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    token_hash text NOT NULL,
    token_encrypted text,
    email_lock text,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_by uuid,
    claimed_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_bans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_bans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid,
    normalized_email text,
    reason text DEFAULT ''::text NOT NULL,
    blocks_registration boolean DEFAULT true NOT NULL,
    blocks_service_access boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    CONSTRAINT customer_bans_normalized_email_check CHECK (((normalized_email IS NULL) OR (normalized_email = lower(btrim(normalized_email)))))
);


--
-- Name: customer_channel_link_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_channel_link_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    channel text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_channel_link_tokens_channel_check CHECK ((channel = ANY (ARRAY['telegram'::text, 'discord'::text])))
);


--
-- Name: TABLE customer_channel_link_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.customer_channel_link_tokens IS 'Short-lived one-time tokens used to bind a signed-in CAPTaINFiN customer to Telegram or Discord without trusting typed handles as delivery addresses.';


--
-- Name: customer_communication_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_communication_preferences (
    customer_id uuid NOT NULL,
    phone_e164 text,
    whatsapp_opt_in boolean DEFAULT false NOT NULL,
    telegram_handle text,
    telegram_opt_in boolean DEFAULT false NOT NULL,
    discord_handle text,
    discord_opt_in boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    telegram_chat_id text,
    telegram_linked_at timestamp with time zone,
    discord_user_id text,
    discord_linked_at timestamp with time zone,
    whatsapp_opted_in_at timestamp with time zone
);


--
-- Name: COLUMN customer_communication_preferences.telegram_chat_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customer_communication_preferences.telegram_chat_id IS 'Verified private Telegram chat id obtained when the customer starts the CAPTaINFiN bot with a one-time link token.';


--
-- Name: COLUMN customer_communication_preferences.discord_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customer_communication_preferences.discord_user_id IS 'Verified immutable Discord user snowflake obtained through Discord OAuth identify.';


--
-- Name: customer_download_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_download_events (
    id bigint NOT NULL,
    customer_id uuid,
    jellyfin_account_id uuid,
    server_id uuid,
    item_id text,
    item_name text,
    item_type text,
    bytes bigint,
    client_name text,
    device_name text,
    source text DEFAULT 'proxy'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_download_events_bytes_check CHECK (((bytes IS NULL) OR (bytes >= 0))),
    CONSTRAINT customer_download_events_source_check CHECK ((source = ANY (ARRAY['proxy'::text, 'jellyfin'::text, 'manual'::text])))
);


--
-- Name: customer_download_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_download_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_download_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_download_events_id_seq OWNED BY public.customer_download_events.id;


--
-- Name: customer_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plan_id uuid NOT NULL,
    token_hash text NOT NULL,
    invited_email text,
    single_use boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name text DEFAULT 'Invitation'::text NOT NULL,
    max_uses integer,
    token_encrypted text,
    CONSTRAINT customer_invitations_check CHECK ((expires_at > created_at)),
    CONSTRAINT customer_invitations_invited_email_check CHECK (((invited_email IS NULL) OR (length(invited_email) <= 254))),
    CONSTRAINT customer_invitations_max_uses_check CHECK (((max_uses IS NULL) OR ((max_uses >= 1) AND (max_uses <= 10000)))),
    CONSTRAINT customer_invitations_name_length_check CHECK (((length(name) >= 1) AND (length(name) <= 120)))
);


--
-- Name: customer_library_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_library_overrides (
    customer_id uuid NOT NULL,
    library_name text NOT NULL,
    granted boolean NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: customer_library_selection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_library_selection (
    customer_id uuid NOT NULL,
    selected_names text[] DEFAULT ARRAY[]::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_notification_preferences (
    customer_id uuid NOT NULL,
    event_type text NOT NULL,
    channel text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_notification_preferences_channel_check CHECK ((channel = ANY (ARRAY['telegram'::text, 'discord'::text, 'whatsapp'::text])))
);


--
-- Name: customer_plan_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_plan_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    current_subscription_id uuid,
    target_plan_id uuid NOT NULL,
    provider text,
    mode text DEFAULT 'period_end'::text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    effective_at timestamp with time zone,
    requested_by uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_schedule_id text,
    provider_schedule_state text,
    provider_action_required boolean DEFAULT false NOT NULL,
    source_price_id text,
    target_price_id text,
    CONSTRAINT customer_plan_changes_mode_check CHECK ((mode = ANY (ARRAY['immediate'::text, 'period_end'::text]))),
    CONSTRAINT customer_plan_changes_provider_check CHECK (((provider IS NULL) OR (provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'manual'::text])))),
    CONSTRAINT customer_plan_changes_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'applied'::text, 'cancelled'::text, 'failed'::text])))
);


--
-- Name: customer_policy_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_policy_overrides (
    customer_id uuid NOT NULL,
    streams integer,
    allow_downloads boolean,
    allow_video_transcoding boolean,
    allow_audio_transcoding boolean,
    allow_remuxing boolean,
    allow_live_tv boolean,
    allow_live_tv_management boolean,
    allow_remote_access boolean,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT customer_policy_overrides_streams_check CHECK (((streams IS NULL) OR (streams > 0)))
);


--
-- Name: customer_provisioning_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_provisioning_state (
    customer_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    last_error text,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    subscription_id uuid,
    plan_id uuid,
    jellyfin_account_id uuid,
    server_id uuid,
    last_result jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_provisioning_state_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'healthy'::text, 'blocked'::text, 'failed'::text])))
);


--
-- Name: customer_server_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_server_migrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    source_account_id uuid NOT NULL,
    source_server_id uuid NOT NULL,
    target_server_id uuid NOT NULL,
    target_account_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_stage text,
    last_error text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    requested_by uuid,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    rolled_back_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_server_migrations_check CHECK ((source_server_id <> target_server_id)),
    CONSTRAINT customer_server_migrations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'rolled_back'::text, 'rollback_failed'::text])))
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    display_name text,
    email text,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    phone text,
    country_code character(2),
    timezone text,
    referral_source text,
    registration_source text,
    discord_user_id text,
    discord_username text,
    marketing_opt_in boolean DEFAULT false NOT NULL,
    tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    access_paused_at timestamp with time zone,
    access_hold_reason text,
    provisioning_mode text DEFAULT 'immediate'::text NOT NULL,
    activation_deadline timestamp with time zone,
    automation_protected boolean DEFAULT false NOT NULL,
    automation_protected_reason text,
    automation_protected_at timestamp with time zone,
    automation_protected_by uuid,
    CONSTRAINT customers_provisioning_mode_check CHECK ((provisioning_mode = ANY (ARRAY['immediate'::text, 'after_activation'::text, 'portal_only'::text])))
);


--
-- Name: discount_checkout_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_checkout_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    discount_code_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    checkout_intent_id uuid NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    amount_applied_minor integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    released_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT discount_checkout_reservations_amount_applied_minor_check CHECK ((amount_applied_minor >= 0)),
    CONSTRAINT discount_checkout_reservations_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'consumed'::text, 'released'::text, 'expired'::text])))
);


--
-- Name: discount_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    discount_type text NOT NULL,
    percent_off integer,
    fixed_off_minor integer,
    currency character(3),
    plan_codes text[],
    max_redemptions integer,
    redemption_count integer DEFAULT 0 NOT NULL,
    per_customer_limit integer DEFAULT 1 NOT NULL,
    starts_at timestamp with time zone,
    expires_at timestamp with time zone,
    active boolean DEFAULT true NOT NULL,
    stripe_coupon_id text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT discount_codes_check CHECK ((((discount_type = 'percent'::text) AND (percent_off IS NOT NULL) AND (fixed_off_minor IS NULL)) OR ((discount_type = 'fixed'::text) AND (fixed_off_minor IS NOT NULL) AND (percent_off IS NULL)))),
    CONSTRAINT discount_codes_discount_type_check CHECK ((discount_type = ANY (ARRAY['percent'::text, 'fixed'::text]))),
    CONSTRAINT discount_codes_fixed_off_minor_check CHECK (((fixed_off_minor IS NULL) OR (fixed_off_minor > 0))),
    CONSTRAINT discount_codes_max_redemptions_check CHECK (((max_redemptions IS NULL) OR (max_redemptions > 0))),
    CONSTRAINT discount_codes_per_customer_limit_check CHECK ((per_customer_limit > 0)),
    CONSTRAINT discount_codes_percent_off_check CHECK (((percent_off IS NULL) OR ((percent_off > 0) AND (percent_off <= 100)))),
    CONSTRAINT discount_codes_redemption_count_check CHECK ((redemption_count >= 0))
);


--
-- Name: discount_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    discount_code_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    subscription_id uuid,
    amount_applied_minor integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT discount_redemptions_amount_applied_minor_check CHECK ((amount_applied_minor >= 0))
);


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    audience text DEFAULT 'direct'::text NOT NULL,
    billing_interval text NOT NULL,
    duration_days integer,
    price_minor integer DEFAULT 0 NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    streams integer DEFAULT 1 NOT NULL,
    allow_downloads boolean DEFAULT false NOT NULL,
    allow_video_transcoding boolean DEFAULT false NOT NULL,
    allow_audio_transcoding boolean DEFAULT true NOT NULL,
    allow_live_tv boolean DEFAULT true NOT NULL,
    allow_live_tv_management boolean DEFAULT false NOT NULL,
    server_class text DEFAULT 'premium'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    visible boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    allow_4k boolean DEFAULT true NOT NULL,
    library_access_mode text DEFAULT 'all'::text NOT NULL,
    library_names text[] DEFAULT ARRAY[]::text[] NOT NULL,
    allow_remuxing boolean DEFAULT false NOT NULL,
    allow_remote_access boolean DEFAULT true NOT NULL,
    placement_strategy text DEFAULT 'balanced'::text NOT NULL,
    request_movie_quota_limit integer,
    request_movie_quota_days integer DEFAULT 30 NOT NULL,
    request_tv_quota_limit integer,
    request_tv_quota_days integer DEFAULT 30 NOT NULL,
    archived_at timestamp with time zone,
    archived_by uuid,
    version_group_id uuid,
    version_number integer DEFAULT 1 NOT NULL,
    effective_from timestamp with time zone,
    effective_until timestamp with time zone,
    service_type text DEFAULT 'jellyfin'::text NOT NULL,
    capacity_limit integer,
    is_addon boolean DEFAULT false NOT NULL,
    inactivity_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_free_tier boolean DEFAULT false NOT NULL,
    marketing_features text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT plans_addon_service_type_check CHECK (((is_addon = false) OR (service_type = 'stremio'::text))),
    CONSTRAINT plans_audience_check CHECK ((audience = 'direct'::text)),
    CONSTRAINT plans_billing_interval_check CHECK ((billing_interval = ANY (ARRAY['trial'::text, 'month'::text, '6_months'::text, 'year'::text, 'custom'::text]))),
    CONSTRAINT plans_capacity_limit_check CHECK (((capacity_limit IS NULL) OR (capacity_limit >= 0))),
    CONSTRAINT plans_library_access_mode_check CHECK ((library_access_mode = ANY (ARRAY['all'::text, 'exclude'::text, 'include'::text]))),
    CONSTRAINT plans_marketing_features_max_four CHECK ((COALESCE(cardinality(marketing_features), 0) <= 4)),
    CONSTRAINT plans_placement_strategy_check CHECK ((placement_strategy = ANY (ARRAY['balanced'::text, 'lowest_customers'::text, 'lowest_streams'::text, 'weighted'::text, 'manual'::text]))),
    CONSTRAINT plans_price_minor_check CHECK ((price_minor >= 0)),
    CONSTRAINT plans_request_movie_quota_days_check CHECK (((request_movie_quota_days >= 1) AND (request_movie_quota_days <= 3650))),
    CONSTRAINT plans_request_movie_quota_limit_check CHECK (((request_movie_quota_limit IS NULL) OR ((request_movie_quota_limit >= 1) AND (request_movie_quota_limit <= 10000)))),
    CONSTRAINT plans_request_tv_quota_days_check CHECK (((request_tv_quota_days >= 1) AND (request_tv_quota_days <= 3650))),
    CONSTRAINT plans_request_tv_quota_limit_check CHECK (((request_tv_quota_limit IS NULL) OR ((request_tv_quota_limit >= 1) AND (request_tv_quota_limit <= 10000)))),
    CONSTRAINT plans_server_class_check CHECK ((server_class = ANY (ARRAY['premium'::text, 'free'::text, 'custom'::text]))),
    CONSTRAINT plans_service_type_check CHECK ((service_type = ANY (ARRAY['jellyfin'::text, 'stremio'::text, 'bundle'::text]))),
    CONSTRAINT plans_streams_check CHECK ((streams > 0))
);


--
-- Name: COLUMN plans.service_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.plans.service_type IS 'Delivery surface: jellyfin, stremio, or bundle. Foundation only until Stremio runtime is enabled.';


--
-- Name: COLUMN plans.is_addon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.plans.is_addon IS 'Independent optional product. Add-ons do not replace the customer primary entitlement.';


--
-- Name: COLUMN plans.inactivity_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.plans.inactivity_policy IS 'Per-plan Jellyfin usage policy. Free Jellyfin/bundle plans may automatically disable Jellyfin access without altering the CAPTaINFiN portal customer.';


--
-- Name: CONSTRAINT plans_addon_service_type_check ON plans; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT plans_addon_service_type_check ON public.plans IS 'Independent add-ons are Stremio-only. Jellyfin + Stremio must be sold as a bundle so primary Jellyfin provisioning remains unambiguous.';


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    current_period_end timestamp with time zone NOT NULL,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    provider_customer_id text,
    provider_subscription_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_by uuid,
    replaced_at timestamp with time zone,
    replacement_reason text,
    plan_name_snapshot text,
    plan_code_snapshot text,
    price_minor_snapshot integer,
    currency_snapshot character(3),
    billing_interval_snapshot text,
    duration_days_snapshot integer,
    provider_price_id_snapshot text,
    service_extension_days integer DEFAULT 0 NOT NULL,
    commercial_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    service_type_snapshot text NOT NULL,
    plan_price_id_snapshot uuid,
    provider_mapping_id_snapshot uuid,
    provider_mapping_external_id_snapshot text,
    CONSTRAINT subscriptions_service_extension_days_check CHECK (((service_extension_days >= 0) AND (service_extension_days <= 3650))),
    CONSTRAINT subscriptions_service_type_snapshot_check CHECK ((service_type_snapshot = ANY (ARRAY['jellyfin'::text, 'stremio'::text, 'bundle'::text]))),
    CONSTRAINT subscriptions_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'stripe'::text, 'paypal'::text, 'migration'::text, 'service_credit'::text]))),
    CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'paused'::text, 'cancelled'::text, 'expired'::text])))
);


--
-- Name: effective_customer_addons; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.effective_customer_addons AS
 SELECT s.customer_id,
    s.id AS subscription_id,
    s.plan_id,
    s.status,
    s.source,
    s.starts_at,
    s.current_period_end,
    COALESCE(s.service_extension_days, 0) AS service_extension_days,
    (s.current_period_end + ((COALESCE(s.service_extension_days, 0) || ' days'::text))::interval) AS access_expires_at,
    s.cancel_at_period_end,
    s.provider_customer_id,
    s.provider_subscription_id,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planName'::text), ''::text), s.plan_name_snapshot, p.name) AS plan_name_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planCode'::text), ''::text), s.plan_code_snapshot, p.code) AS plan_code_snapshot,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'priceMinor'::text) ~ '^-?[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'priceMinor'::text))::integer
            ELSE NULL::integer
        END, s.price_minor_snapshot, p.price_minor) AS price_minor_snapshot,
    (COALESCE(NULLIF((s.commercial_snapshot ->> 'currency'::text), ''::text), (s.currency_snapshot)::text, (p.currency)::text))::character(3) AS currency_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'billingInterval'::text), ''::text), s.billing_interval_snapshot, p.billing_interval) AS billing_interval_snapshot,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'durationDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'durationDays'::text))::integer
            ELSE NULL::integer
        END, s.duration_days_snapshot, p.duration_days) AS duration_days_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'providerMappingId'::text), ''::text), s.provider_price_id_snapshot) AS provider_price_id_snapshot,
    s.service_type_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planCode'::text), ''::text), s.plan_code_snapshot, p.code) AS code,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planName'::text), ''::text), s.plan_name_snapshot, p.name) AS name,
    p.audience,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'billingInterval'::text), ''::text), s.billing_interval_snapshot, p.billing_interval) AS billing_interval,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'durationDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'durationDays'::text))::integer
            ELSE NULL::integer
        END, s.duration_days_snapshot, p.duration_days) AS duration_days,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'priceMinor'::text) ~ '^-?[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'priceMinor'::text))::integer
            ELSE NULL::integer
        END, s.price_minor_snapshot, p.price_minor) AS price_minor,
    (COALESCE(NULLIF((s.commercial_snapshot ->> 'currency'::text), ''::text), (s.currency_snapshot)::text, (p.currency)::text))::character(3) AS currency,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'streams'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'streams'::text))::integer
            ELSE NULL::integer
        END, p.streams) AS streams,
    p.service_type,
        CASE
            WHEN (s.commercial_snapshot ? 'allowDownloads'::text) THEN ((s.commercial_snapshot ->> 'allowDownloads'::text))::boolean
            ELSE p.allow_downloads
        END AS allow_downloads,
        CASE
            WHEN (s.commercial_snapshot ? 'allowVideoTranscoding'::text) THEN ((s.commercial_snapshot ->> 'allowVideoTranscoding'::text))::boolean
            ELSE p.allow_video_transcoding
        END AS allow_video_transcoding,
        CASE
            WHEN (s.commercial_snapshot ? 'allowAudioTranscoding'::text) THEN ((s.commercial_snapshot ->> 'allowAudioTranscoding'::text))::boolean
            ELSE p.allow_audio_transcoding
        END AS allow_audio_transcoding,
        CASE
            WHEN (s.commercial_snapshot ? 'allowLiveTv'::text) THEN ((s.commercial_snapshot ->> 'allowLiveTv'::text))::boolean
            ELSE p.allow_live_tv
        END AS allow_live_tv,
        CASE
            WHEN (s.commercial_snapshot ? 'allowLiveTvManagement'::text) THEN ((s.commercial_snapshot ->> 'allowLiveTvManagement'::text))::boolean
            ELSE p.allow_live_tv_management
        END AS allow_live_tv_management,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'serverClass'::text), ''::text), p.server_class) AS server_class,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'requestMovieQuotaLimit'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestMovieQuotaLimit'::text))::integer
            ELSE NULL::integer
        END, p.request_movie_quota_limit) AS request_movie_quota_limit,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'requestMovieQuotaDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestMovieQuotaDays'::text))::integer
            ELSE NULL::integer
        END, p.request_movie_quota_days) AS request_movie_quota_days,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'requestTvQuotaLimit'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestTvQuotaLimit'::text))::integer
            ELSE NULL::integer
        END, p.request_tv_quota_limit) AS request_tv_quota_limit,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'requestTvQuotaDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestTvQuotaDays'::text))::integer
            ELSE NULL::integer
        END, p.request_tv_quota_days) AS request_tv_quota_days,
    (EXISTS ( SELECT 1
           FROM public.customer_access_holds h
          WHERE ((h.customer_id = s.customer_id) AND (h.released_at IS NULL)))) AS blocked
   FROM (public.subscriptions s
     JOIN public.plans p ON ((p.id = s.plan_id)))
  WHERE ((p.is_addon = true) AND (s.superseded_by IS NULL) AND (s.starts_at <= now()) AND (((s.status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'paused'::text])) AND (s.current_period_end > now())) OR ((COALESCE(s.service_extension_days, 0) > 0) AND (s.status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'paused'::text, 'cancelled'::text, 'expired'::text])) AND ((s.current_period_end + ((s.service_extension_days || ' days'::text))::interval) > now()))));


--
-- Name: VIEW effective_customer_addons; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.effective_customer_addons IS 'All currently-effective add-on subscriptions, separate from the single primary customer entitlement.';


--
-- Name: effective_customer_entitlements; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.effective_customer_entitlements AS
 SELECT DISTINCT ON (s.customer_id) s.customer_id,
    s.id AS subscription_id,
    s.plan_id,
    s.status,
    s.source,
    s.starts_at,
    s.current_period_end,
    COALESCE(s.service_extension_days, 0) AS service_extension_days,
    (s.current_period_end + ((COALESCE(s.service_extension_days, 0) || ' days'::text))::interval) AS access_expires_at,
    s.cancel_at_period_end,
    s.provider_customer_id,
    s.provider_subscription_id,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planName'::text), ''::text), s.plan_name_snapshot, p.name) AS plan_name_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planCode'::text), ''::text), s.plan_code_snapshot, p.code) AS plan_code_snapshot,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'priceMinor'::text) ~ '^-?[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'priceMinor'::text))::integer
            ELSE NULL::integer
        END, s.price_minor_snapshot, p.price_minor) AS price_minor_snapshot,
    (COALESCE(NULLIF((s.commercial_snapshot ->> 'currency'::text), ''::text), (s.currency_snapshot)::text, (p.currency)::text))::character(3) AS currency_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'billingInterval'::text), ''::text), s.billing_interval_snapshot, p.billing_interval) AS billing_interval_snapshot,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'durationDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'durationDays'::text))::integer
            ELSE NULL::integer
        END, s.duration_days_snapshot, p.duration_days) AS duration_days_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'providerMappingId'::text), ''::text), s.provider_price_id_snapshot) AS provider_price_id_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planCode'::text), ''::text), s.plan_code_snapshot, p.code) AS code,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planName'::text), ''::text), s.plan_name_snapshot, p.name) AS name,
    p.audience,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'billingInterval'::text), ''::text), s.billing_interval_snapshot, p.billing_interval) AS billing_interval,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'durationDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'durationDays'::text))::integer
            ELSE NULL::integer
        END, s.duration_days_snapshot, p.duration_days) AS duration_days,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'priceMinor'::text) ~ '^-?[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'priceMinor'::text))::integer
            ELSE NULL::integer
        END, s.price_minor_snapshot, p.price_minor) AS price_minor,
    (COALESCE(NULLIF((s.commercial_snapshot ->> 'currency'::text), ''::text), (s.currency_snapshot)::text, (p.currency)::text))::character(3) AS currency,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'streams'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'streams'::text))::integer
            ELSE NULL::integer
        END, p.streams) AS streams,
        CASE
            WHEN (s.commercial_snapshot ? 'allowDownloads'::text) THEN ((s.commercial_snapshot ->> 'allowDownloads'::text))::boolean
            ELSE p.allow_downloads
        END AS allow_downloads,
        CASE
            WHEN (s.commercial_snapshot ? 'allowVideoTranscoding'::text) THEN ((s.commercial_snapshot ->> 'allowVideoTranscoding'::text))::boolean
            ELSE p.allow_video_transcoding
        END AS allow_video_transcoding,
        CASE
            WHEN (s.commercial_snapshot ? 'allowAudioTranscoding'::text) THEN ((s.commercial_snapshot ->> 'allowAudioTranscoding'::text))::boolean
            ELSE p.allow_audio_transcoding
        END AS allow_audio_transcoding,
        CASE
            WHEN (s.commercial_snapshot ? 'allowLiveTv'::text) THEN ((s.commercial_snapshot ->> 'allowLiveTv'::text))::boolean
            ELSE p.allow_live_tv
        END AS allow_live_tv,
        CASE
            WHEN (s.commercial_snapshot ? 'allowLiveTvManagement'::text) THEN ((s.commercial_snapshot ->> 'allowLiveTvManagement'::text))::boolean
            ELSE p.allow_live_tv_management
        END AS allow_live_tv_management,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'serverClass'::text), ''::text), p.server_class) AS server_class,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'requestMovieQuotaLimit'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestMovieQuotaLimit'::text))::integer
            ELSE NULL::integer
        END, p.request_movie_quota_limit) AS request_movie_quota_limit,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'requestMovieQuotaDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestMovieQuotaDays'::text))::integer
            ELSE NULL::integer
        END, p.request_movie_quota_days) AS request_movie_quota_days,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'requestTvQuotaLimit'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestTvQuotaLimit'::text))::integer
            ELSE NULL::integer
        END, p.request_tv_quota_limit) AS request_tv_quota_limit,
    COALESCE(
        CASE
            WHEN ((s.commercial_snapshot ->> 'requestTvQuotaDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestTvQuotaDays'::text))::integer
            ELSE NULL::integer
        END, p.request_tv_quota_days) AS request_tv_quota_days,
    (EXISTS ( SELECT 1
           FROM public.customer_access_holds h
          WHERE ((h.customer_id = s.customer_id) AND (h.released_at IS NULL)))) AS blocked
   FROM (public.subscriptions s
     JOIN public.plans p ON ((p.id = s.plan_id)))
  WHERE ((COALESCE(p.is_addon, false) = false) AND (s.superseded_by IS NULL) AND (s.starts_at <= now()) AND (((s.status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'paused'::text])) AND (s.current_period_end > now())) OR ((COALESCE(s.service_extension_days, 0) > 0) AND (s.status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'paused'::text, 'cancelled'::text, 'expired'::text])) AND ((s.current_period_end + ((s.service_extension_days || ' days'::text))::interval) > now()))))
  ORDER BY s.customer_id, (s.current_period_end + ((COALESCE(s.service_extension_days, 0) || ' days'::text))::interval) DESC, s.created_at DESC;


--
-- Name: email_gateway_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_gateway_settings (
    id smallint DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    host text,
    port integer,
    secure_mode text DEFAULT 'starttls'::text NOT NULL,
    username text,
    password_encrypted text,
    from_name text,
    from_email text,
    reply_to text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_gateway_settings_id_check CHECK ((id = 1)),
    CONSTRAINT email_gateway_settings_port_check CHECK (((port IS NULL) OR ((port >= 1) AND (port <= 65535)))),
    CONSTRAINT email_gateway_settings_secure_mode_check CHECK ((secure_mode = ANY (ARRAY['tls'::text, 'starttls'::text, 'plain'::text])))
);


--
-- Name: free_access_registration_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.free_access_registration_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pending_registration_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    normalized_email text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    released_at timestamp with time zone,
    customer_id uuid,
    subscription_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT free_access_registration_reservations_check CHECK ((NOT ((consumed_at IS NOT NULL) AND (released_at IS NOT NULL))))
);


--
-- Name: invitation_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitation_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invitation_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    user_id uuid NOT NULL,
    redeemed_email text,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: jellyfin_account_lifecycle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jellyfin_account_lifecycle (
    id bigint NOT NULL,
    account_id uuid,
    customer_id uuid NOT NULL,
    server_id uuid NOT NULL,
    jellyfin_user_id text NOT NULL,
    jellyfin_username text,
    category text NOT NULL,
    reason text NOT NULL,
    policy_source text DEFAULT 'global'::text NOT NULL,
    disabled_at timestamp with time zone NOT NULL,
    delete_after timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    restored_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE jellyfin_account_lifecycle; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.jellyfin_account_lifecycle IS 'Jellyfin-only lifecycle state. Automated lifecycle must never disable/delete the CAPTaINFiN portal customer.';


--
-- Name: jellyfin_account_lifecycle_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.jellyfin_account_lifecycle_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: jellyfin_account_lifecycle_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.jellyfin_account_lifecycle_id_seq OWNED BY public.jellyfin_account_lifecycle.id;


--
-- Name: jellyfin_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jellyfin_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    server_id uuid NOT NULL,
    jellyfin_user_id text NOT NULL,
    jellyfin_username text NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    last_activity_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_policy_sync timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    password_reset_required boolean DEFAULT false NOT NULL,
    password_setup_required boolean DEFAULT false NOT NULL,
    account_purpose text DEFAULT 'jellyfin'::text NOT NULL,
    CONSTRAINT jellyfin_accounts_account_purpose_check CHECK ((account_purpose = ANY (ARRAY['jellyfin'::text, 'stremio_internal'::text])))
);


--
-- Name: jellyfin_policy_drift; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jellyfin_policy_drift (
    jellyfin_account_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    server_id uuid NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    desired_disabled boolean,
    desired_hash text,
    remote_hash text,
    differences jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_checked_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_error text,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    next_check_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jellyfin_policy_drift_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT jellyfin_policy_drift_status_check CHECK ((status = ANY (ARRAY['unknown'::text, 'in_sync'::text, 'drift'::text, 'unreachable'::text, 'missing'::text])))
);


--
-- Name: jellyfin_policy_reconciliation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jellyfin_policy_reconciliation (
    jellyfin_account_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    last_attempt_at timestamp with time zone,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_policy_hash text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    desired_policy_hash text,
    last_success_at timestamp with time zone,
    last_verified_at timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone,
    drift_detected_at timestamp with time zone,
    CONSTRAINT jellyfin_policy_reconciliation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'successful'::text, 'failed'::text])))
);


--
-- Name: jellyfin_server_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jellyfin_server_metrics (
    server_id uuid NOT NULL,
    total_users integer,
    active_streams integer,
    managed_streams integer,
    transcode_streams integer,
    direct_stream_streams integer,
    direct_play_streams integer,
    paused_streams integer,
    observed_at timestamp with time zone,
    last_error text,
    error_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jellyfin_server_metrics_active_streams_check CHECK (((active_streams IS NULL) OR (active_streams >= 0))),
    CONSTRAINT jellyfin_server_metrics_direct_play_streams_check CHECK (((direct_play_streams IS NULL) OR (direct_play_streams >= 0))),
    CONSTRAINT jellyfin_server_metrics_direct_stream_streams_check CHECK (((direct_stream_streams IS NULL) OR (direct_stream_streams >= 0))),
    CONSTRAINT jellyfin_server_metrics_managed_streams_check CHECK (((managed_streams IS NULL) OR (managed_streams >= 0))),
    CONSTRAINT jellyfin_server_metrics_paused_streams_check CHECK (((paused_streams IS NULL) OR (paused_streams >= 0))),
    CONSTRAINT jellyfin_server_metrics_total_users_check CHECK (((total_users IS NULL) OR (total_users >= 0))),
    CONSTRAINT jellyfin_server_metrics_transcode_streams_check CHECK (((transcode_streams IS NULL) OR (transcode_streams >= 0)))
);


--
-- Name: jellyfin_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jellyfin_servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    server_class text NOT NULL,
    base_url text NOT NULL,
    public_url text,
    api_key_encrypted text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    max_users integer,
    health_status text DEFAULT 'unknown'::text NOT NULL,
    last_health_check timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    location text,
    allow_new_users boolean DEFAULT true NOT NULL,
    trial_enabled boolean DEFAULT true NOT NULL,
    paid_enabled boolean DEFAULT true NOT NULL,
    placement_mode text DEFAULT 'active'::text NOT NULL,
    stremio_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT jellyfin_servers_health_status_check CHECK ((health_status = ANY (ARRAY['unknown'::text, 'healthy'::text, 'degraded'::text, 'offline'::text]))),
    CONSTRAINT jellyfin_servers_placement_mode_check CHECK ((placement_mode = ANY (ARRAY['active'::text, 'drain'::text, 'maintenance'::text]))),
    CONSTRAINT jellyfin_servers_server_class_check CHECK ((server_class = ANY (ARRAY['premium'::text, 'free'::text, 'custom'::text])))
);


--
-- Name: COLUMN jellyfin_servers.stremio_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jellyfin_servers.stremio_enabled IS 'Explicit opt-in for future Stremio placement. Does not change normal Jellyfin placement.';


--
-- Name: login_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_rate_limits (
    bucket_key text NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT login_rate_limits_attempt_count_check CHECK ((attempt_count >= 0))
);


--
-- Name: request_quality_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_quality_tiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: request_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quality_tier_id uuid NOT NULL,
    media_type text NOT NULL,
    arr_instance_id uuid NOT NULL,
    quality_profile_id integer NOT NULL,
    quality_profile_name text NOT NULL,
    root_folder_path text NOT NULL,
    monitor_mode text DEFAULT 'all'::text NOT NULL,
    search_on_add boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT request_routes_media_type_check CHECK ((media_type = ANY (ARRAY['movie'::text, 'series'::text]))),
    CONSTRAINT request_routes_quality_profile_id_check CHECK ((quality_profile_id > 0))
);


--
-- Name: media_quality_options; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.media_quality_options AS
 SELECT qt.id,
    qt.code,
    qt.name,
    qt.description,
    qt.active,
    qt.sort_order,
    rr.media_type,
    rr.search_on_add,
    rr.enabled AS route_enabled,
    rr.arr_instance_id,
    ai.name AS instance_name,
    ai.kind AS instance_kind,
    ai.enabled AS instance_enabled
   FROM ((public.request_quality_tiers qt
     LEFT JOIN public.request_routes rr ON ((rr.quality_tier_id = qt.id)))
     LEFT JOIN public.arr_instances ai ON ((ai.id = rr.arr_instance_id)));


--
-- Name: media_route_details; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.media_route_details AS
 SELECT rr.id,
    rr.quality_tier_id,
    qt.code AS tier_code,
    qt.name AS tier_name,
    rr.media_type,
    rr.arr_instance_id,
    ai.name AS instance_name,
    ai.kind AS instance_kind,
    ai.health_status,
    rr.quality_profile_id,
    rr.quality_profile_name,
    rr.root_folder_path,
    rr.monitor_mode,
    rr.search_on_add,
    rr.enabled,
    rr.created_at,
    rr.updated_at
   FROM ((public.request_routes rr
     JOIN public.request_quality_tiers qt ON ((qt.id = rr.quality_tier_id)))
     JOIN public.arr_instances ai ON ((ai.id = rr.arr_instance_id)));


--
-- Name: native_staff_legacy_compat_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.native_staff_legacy_compat_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel text DEFAULT 'email'::text NOT NULL,
    message_type text NOT NULL,
    recipient_email text,
    payload_encrypted text,
    dedupe_key text,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    sent_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    event_type text,
    destination text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT notification_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT notification_outbox_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'telegram'::text, 'webhook'::text, 'discord'::text, 'whatsapp'::text]))),
    CONSTRAINT notification_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'dead'::text, 'cancelled'::text])))
);


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    event_type text NOT NULL,
    telegram_enabled boolean DEFAULT false NOT NULL,
    email_enabled boolean DEFAULT false NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    discord_enabled boolean DEFAULT false NOT NULL,
    whatsapp_enabled boolean DEFAULT false NOT NULL,
    event_scope text DEFAULT 'admin'::text NOT NULL,
    customer_opt_in_allowed boolean DEFAULT false NOT NULL,
    display_name text,
    description text,
    CONSTRAINT notification_preferences_event_scope_check CHECK ((event_scope = ANY (ARRAY['admin'::text, 'customer'::text, 'both'::text])))
);


--
-- Name: operational_worker_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operational_worker_state (
    worker_key text NOT NULL,
    instance_id text NOT NULL,
    version text,
    commit_sha text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    draining_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    provider text NOT NULL,
    provider_customer_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_customers_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text])))
);


--
-- Name: payment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    processed_at timestamp with time zone,
    processing_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processing_started_at timestamp with time zone,
    processing_token uuid,
    CONSTRAINT payment_events_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'manual'::text])))
);


--
-- Name: payment_incident_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_incident_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    incident_id uuid NOT NULL,
    actor_user_id uuid,
    note text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_incidents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    provider_case_id text,
    incident_type text NOT NULL,
    incident_status text DEFAULT 'open'::text NOT NULL,
    scope text DEFAULT 'unresolved'::text NOT NULL,
    customer_id uuid,
    provider_subscription_id text,
    amount_minor bigint,
    currency character(3),
    access_action text DEFAULT 'preserve'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    acknowledged_by uuid,
    assigned_to uuid,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    resolution_note text,
    CONSTRAINT payment_incidents_access_action_check CHECK ((access_action = ANY (ARRAY['preserve'::text, 'provider_state'::text, 'suspend'::text, 'restore'::text]))),
    CONSTRAINT payment_incidents_incident_status_check CHECK ((incident_status = ANY (ARRAY['open'::text, 'resolved'::text, 'won'::text, 'lost'::text, 'recorded'::text]))),
    CONSTRAINT payment_incidents_incident_type_check CHECK ((incident_type = ANY (ARRAY['refund'::text, 'dispute'::text, 'chargeback'::text, 'failed_renewal'::text, 'checkout_completion'::text]))),
    CONSTRAINT payment_incidents_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text])))
);


--
-- Name: payment_provider_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_provider_credentials (
    provider text NOT NULL,
    secrets_encrypted text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_provider_credentials_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text])))
);


--
-- Name: pending_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    referral_code text,
    token_hash character(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    communication_preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    free_access_requested boolean DEFAULT false NOT NULL
);


--
-- Name: plan_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_prices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plan_id uuid NOT NULL,
    currency character(3) NOT NULL,
    price_minor integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plan_prices_currency_check CHECK ((currency = ANY (ARRAY['GBP'::bpchar, 'USD'::bpchar, 'EUR'::bpchar]))),
    CONSTRAINT plan_prices_price_minor_check CHECK ((price_minor >= 0))
);


--
-- Name: plan_provider_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_provider_prices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plan_id uuid NOT NULL,
    provider text NOT NULL,
    external_id text,
    checkout_mode text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    verification_status text,
    verification_error text,
    remote_amount_minor integer,
    remote_currency character(3),
    remote_interval text,
    remote_active boolean,
    validation_state text DEFAULT 'unverified'::text NOT NULL,
    validated_at timestamp with time zone,
    validation_error text,
    validated_external_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    plan_price_id uuid NOT NULL,
    CONSTRAINT plan_provider_prices_checkout_mode_check CHECK ((checkout_mode = ANY (ARRAY['payment'::text, 'subscription'::text]))),
    CONSTRAINT plan_provider_prices_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text]))),
    CONSTRAINT plan_provider_prices_validation_state_check CHECK ((validation_state = ANY (ARRAY['unverified'::text, 'verified'::text, 'failed'::text]))),
    CONSTRAINT plan_provider_prices_verification_status_check CHECK (((verification_status IS NULL) OR (verification_status = ANY (ARRAY['unverified'::text, 'verified'::text, 'drift'::text, 'error'::text, 'not_required'::text]))))
);


--
-- Name: plan_server_eligibility; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_server_eligibility (
    plan_id uuid NOT NULL,
    server_id uuid NOT NULL,
    weight integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plan_server_eligibility_weight_check CHECK (((weight >= 1) AND (weight <= 10000)))
);


--
-- Name: plan_stremio_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_stremio_sources (
    plan_id uuid NOT NULL,
    source_id uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plan_stremio_sources_priority_check CHECK (((priority >= 1) AND (priority <= 10000)))
);


--
-- Name: TABLE plan_stremio_sources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.plan_stremio_sources IS 'Per-plan Stremio source allow-list and priority. Empty mapping preserves compatibility with the managed-server delivery path.';


--
-- Name: platform_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_settings (
    setting_key text NOT NULL,
    setting_value jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: playback_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playback_history (
    id bigint NOT NULL,
    server_id uuid NOT NULL,
    customer_id uuid,
    jellyfin_account_id uuid,
    playback_key text NOT NULL,
    jellyfin_session_id text NOT NULL,
    item_id text,
    item_name text,
    item_type text,
    client_name text,
    device_name text,
    playback_method text DEFAULT 'unknown'::text NOT NULL,
    transcode_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    started_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    ended_reason text,
    CONSTRAINT playback_history_playback_method_check CHECK ((playback_method = ANY (ARRAY['directplay'::text, 'directstream'::text, 'transcode'::text, 'unknown'::text])))
);


--
-- Name: playback_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playback_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playback_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playback_history_id_seq OWNED BY public.playback_history.id;


--
-- Name: provider_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    scope text NOT NULL,
    owner_id uuid NOT NULL,
    operation_type text NOT NULL,
    local_reference text,
    provider_reference text,
    idempotency_key text NOT NULL,
    request_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_result jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text DEFAULT 'planned'::text NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_applied_at timestamp with time zone,
    local_applied_at timestamp with time zone,
    reconciled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_operations_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text]))),
    CONSTRAINT provider_operations_state_check CHECK ((state = ANY (ARRAY['planned'::text, 'provider_applied'::text, 'local_applied'::text, 'reconciled'::text, 'compensated'::text, 'failed'::text])))
);


--
-- Name: provisioning_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provisioning_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    subscription_id uuid,
    action text NOT NULL,
    status text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT provisioning_runs_action_check CHECK ((action = ANY (ARRAY['provision'::text, 'reconcile'::text, 'disable'::text, 'password_reset'::text]))),
    CONSTRAINT provisioning_runs_status_check CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: referral_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: referral_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    referral_code_id uuid NOT NULL,
    referred_customer_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reward_note text,
    rewarded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referral_redemptions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'rewarded'::text, 'unfulfilled'::text, 'reversed'::text])))
);


--
-- Name: referral_reward_reversals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_reward_reversals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    redemption_id uuid NOT NULL,
    subscription_id uuid,
    payment_incident_id uuid,
    days_reversed integer DEFAULT 0 NOT NULL,
    reason text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referral_reward_reversals_days_reversed_check CHECK (((days_reversed >= 0) AND (days_reversed <= 365)))
);


--
-- Name: referral_service_credits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_service_credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    source_redemption_id uuid,
    plan_id uuid,
    days_total integer NOT NULL,
    days_consumed integer DEFAULT 0 NOT NULL,
    state text DEFAULT 'banked'::text NOT NULL,
    applied_subscription_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    note text,
    CONSTRAINT referral_service_credits_days_consumed_check CHECK ((days_consumed >= 0)),
    CONSTRAINT referral_service_credits_days_total_check CHECK (((days_total > 0) AND (days_total <= 3650))),
    CONSTRAINT referral_service_credits_state_check CHECK ((state = ANY (ARRAY['banked'::text, 'applied'::text, 'cancelled'::text])))
);


--
-- Name: request_service_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_service_settings (
    id smallint DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    base_url text,
    api_key_encrypted text,
    sync_interval_minutes integer DEFAULT 15 NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT request_service_settings_id_check CHECK ((id = 1)),
    CONSTRAINT request_service_settings_sync_interval_minutes_check CHECK (((sync_interval_minutes >= 5) AND (sync_interval_minutes <= 1440)))
);


--
-- Name: request_user_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_user_sync (
    customer_id uuid NOT NULL,
    external_user_id bigint,
    external_email text,
    external_username text,
    status text DEFAULT 'pending'::text NOT NULL,
    password_reset_required boolean DEFAULT false NOT NULL,
    last_error text,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active_permissions integer,
    access_suspended boolean DEFAULT false NOT NULL,
    applied_plan_id uuid,
    applied_movie_quota_limit integer,
    applied_movie_quota_days integer,
    applied_tv_quota_limit integer,
    applied_tv_quota_days integer,
    CONSTRAINT request_user_sync_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'synced'::text, 'skipped'::text, 'failed'::text])))
);


--
-- Name: stream_policy_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_policy_events (
    id bigint NOT NULL,
    customer_id uuid,
    server_id uuid,
    jellyfin_account_id uuid,
    jellyfin_session_id text,
    mode text NOT NULL,
    decision text NOT NULL,
    stream_count integer,
    stream_limit integer,
    reason text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stream_policy_events_decision_check CHECK ((decision = ANY (ARRAY['observed'::text, 'pending'::text, 'would_stop'::text, 'stopped'::text, 'stop_failed'::text, 'skipped_safety'::text]))),
    CONSTRAINT stream_policy_events_mode_check CHECK ((mode = ANY (ARRAY['observe'::text, 'enforce'::text])))
);


--
-- Name: stream_policy_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stream_policy_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stream_policy_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stream_policy_events_id_seq OWNED BY public.stream_policy_events.id;


--
-- Name: stremio_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stremio_entitlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    server_id uuid,
    jellyfin_account_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    stream_limit integer NOT NULL,
    token_hash text,
    token_hint text,
    token_version integer DEFAULT 1 NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    jellyfin_access_token_encrypted text,
    jellyfin_token_issued_at timestamp with time zone,
    install_issued_at timestamp with time zone,
    last_manifest_at timestamp with time zone,
    last_stream_request_at timestamp with time zone,
    last_error text,
    CONSTRAINT stremio_entitlement_token_hash_format CHECK (((token_hash IS NULL) OR (token_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT stremio_entitlements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text, 'revoked'::text]))),
    CONSTRAINT stremio_entitlements_stream_limit_check CHECK (((stream_limit >= 1) AND (stream_limit <= 50))),
    CONSTRAINT stremio_entitlements_token_version_check CHECK ((token_version > 0))
);


--
-- Name: TABLE stremio_entitlements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.stremio_entitlements IS 'Control-plane state for user-specific Stremio addon access. Raw install tokens are never stored.';


--
-- Name: stremio_media_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stremio_media_index (
    server_id uuid NOT NULL,
    imdb_id text NOT NULL,
    item_id text NOT NULL,
    item_type text NOT NULL,
    name text,
    production_year integer,
    path text,
    scan_generation uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stremio_media_index_item_type_check CHECK ((item_type = ANY (ARRAY['Movie'::text, 'Series'::text])))
);


--
-- Name: stremio_media_index_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stremio_media_index_state (
    server_id uuid NOT NULL,
    status text DEFAULT 'never'::text NOT NULL,
    last_started_at timestamp with time zone,
    last_completed_at timestamp with time zone,
    item_count integer DEFAULT 0 NOT NULL,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stremio_media_index_state_item_count_check CHECK ((item_count >= 0)),
    CONSTRAINT stremio_media_index_state_status_check CHECK ((status = ANY (ARRAY['never'::text, 'running'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: stremio_source_index_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stremio_source_index_state (
    source_id uuid NOT NULL,
    status text DEFAULT 'never'::text NOT NULL,
    last_mode text,
    last_started_at timestamp with time zone,
    last_completed_at timestamp with time zone,
    last_full_completed_at timestamp with time zone,
    next_incremental_at timestamp with time zone DEFAULT now() NOT NULL,
    force_full boolean DEFAULT true NOT NULL,
    item_count integer DEFAULT 0 NOT NULL,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stremio_source_index_state_item_count_check CHECK ((item_count >= 0)),
    CONSTRAINT stremio_source_index_state_last_mode_check CHECK (((last_mode IS NULL) OR (last_mode = ANY (ARRAY['full'::text, 'incremental'::text])))),
    CONSTRAINT stremio_source_index_state_status_check CHECK ((status = ANY (ARRAY['never'::text, 'queued'::text, 'running'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: TABLE stremio_source_index_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.stremio_source_index_state IS 'Per-source lightweight sync state: six-hour incremental indexing with periodic full reconciliation.';


--
-- Name: stremio_source_libraries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stremio_source_libraries (
    source_id uuid NOT NULL,
    library_id text NOT NULL,
    name text NOT NULL,
    collection_type text,
    selected boolean DEFAULT false NOT NULL,
    available boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE stremio_source_libraries; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.stremio_source_libraries IS 'Libraries visible to the dedicated Jellyfin source account. Only selected libraries are indexed for Stremio.';


--
-- Name: stremio_source_media_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stremio_source_media_index (
    source_id uuid NOT NULL,
    library_id text NOT NULL,
    imdb_id text NOT NULL,
    item_id text NOT NULL,
    item_type text NOT NULL,
    name text,
    production_year integer,
    path text,
    date_last_saved timestamp with time zone,
    scan_generation uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stremio_source_media_index_item_type_check CHECK ((item_type = ANY (ARRAY['Movie'::text, 'Series'::text])))
);


--
-- Name: TABLE stremio_source_media_index; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.stremio_source_media_index IS 'Local IMDb lookup index for selected libraries on external/shared Jellyfin Stremio sources.';


--
-- Name: stremio_source_playback_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stremio_source_playback_leases (
    lease_hash text NOT NULL,
    entitlement_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    source_id uuid NOT NULL,
    item_id text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: TABLE stremio_source_playback_leases; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.stremio_source_playback_leases IS 'Short-lived CAPTAiNFiN admission leases enforcing per-entitlement external Stremio stream concurrency.';


--
-- Name: stremio_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stremio_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    source_kind text DEFAULT 'external'::text NOT NULL,
    server_id uuid,
    base_url text NOT NULL,
    public_url text NOT NULL,
    jellyfin_user_id text NOT NULL,
    jellyfin_username text,
    access_token_encrypted text NOT NULL,
    weight integer DEFAULT 100 NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    authorization_confirmed boolean DEFAULT false NOT NULL,
    last_success_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_state text DEFAULT 'connected'::text NOT NULL,
    last_connected_at timestamp with time zone,
    last_auth_check_at timestamp with time zone,
    CONSTRAINT stremio_sources_auth_state_check CHECK ((auth_state = ANY (ARRAY['connected'::text, 'reconnect_required'::text, 'error'::text]))),
    CONSTRAINT stremio_sources_check CHECK (((source_kind = 'owned'::text) OR (authorization_confirmed = true))),
    CONSTRAINT stremio_sources_priority_check CHECK (((priority >= 1) AND (priority <= 10000))),
    CONSTRAINT stremio_sources_source_kind_check CHECK ((source_kind = ANY (ARRAY['owned'::text, 'external'::text]))),
    CONSTRAINT stremio_sources_weight_check CHECK (((weight >= 1) AND (weight <= 10000)))
);


--
-- Name: TABLE stremio_sources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.stremio_sources IS 'Authorized Jellyfin bridge/service accounts used by the Stremio source pool. External sources require explicit authorization confirmation.';


--
-- Name: stremio_stream_attribution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stremio_stream_attribution (
    id bigint NOT NULL,
    entitlement_id uuid,
    customer_id uuid NOT NULL,
    source_id uuid,
    source_name text NOT NULL,
    video_type text NOT NULL,
    video_id text NOT NULL,
    item_id text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: TABLE stremio_stream_attribution; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.stremio_stream_attribution IS 'CAPTaINFiN-side attribution of Stremio stream requests to the real portal customer while upstream Jellyfin sees the configured bridge account.';


--
-- Name: stremio_stream_attribution_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stremio_stream_attribution_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stremio_stream_attribution_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stremio_stream_attribution_id_seq OWNED BY public.stremio_stream_attribution.id;


--
-- Name: subscription_provider_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_provider_sync (
    subscription_id uuid NOT NULL,
    provider text NOT NULL,
    remote_status text,
    remote_period_end timestamp with time zone,
    remote_cancel_at_period_end boolean,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_error text,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_provider_sync_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT subscription_provider_sync_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text])))
);


--
-- Name: subscription_service_extension_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_service_extension_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscription_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    source text NOT NULL,
    days integer NOT NULL,
    reference_id text,
    actor_user_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_service_extension_events_days_check CHECK (((days > 0) AND (days <= 365)))
);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: auth_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_events ALTER COLUMN id SET DEFAULT nextval('public.auth_events_id_seq'::regclass);


--
-- Name: background_job_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_job_items ALTER COLUMN id SET DEFAULT nextval('public.background_job_items_id_seq'::regclass);


--
-- Name: customer_download_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_download_events ALTER COLUMN id SET DEFAULT nextval('public.customer_download_events_id_seq'::regclass);


--
-- Name: jellyfin_account_lifecycle id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_account_lifecycle ALTER COLUMN id SET DEFAULT nextval('public.jellyfin_account_lifecycle_id_seq'::regclass);


--
-- Name: playback_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history ALTER COLUMN id SET DEFAULT nextval('public.playback_history_id_seq'::regclass);


--
-- Name: stream_policy_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_policy_events ALTER COLUMN id SET DEFAULT nextval('public.stream_policy_events_id_seq'::regclass);


--
-- Name: stremio_stream_attribution id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_stream_attribution ALTER COLUMN id SET DEFAULT nextval('public.stremio_stream_attribution_id_seq'::regclass);


--
-- Name: account_activation_tokens account_activation_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_activation_tokens
    ADD CONSTRAINT account_activation_tokens_pkey PRIMARY KEY (id);


--
-- Name: account_activation_tokens account_activation_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_activation_tokens
    ADD CONSTRAINT account_activation_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: account_tokens account_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_tokens
    ADD CONSTRAINT account_tokens_pkey PRIMARY KEY (id);


--
-- Name: account_tokens account_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_tokens
    ADD CONSTRAINT account_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: active_playback_sessions active_playback_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_playback_sessions
    ADD CONSTRAINT active_playback_sessions_pkey PRIMARY KEY (server_id, jellyfin_session_id);


--
-- Name: admin_channel_link_tokens admin_channel_link_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_channel_link_tokens
    ADD CONSTRAINT admin_channel_link_tokens_pkey PRIMARY KEY (id);


--
-- Name: admin_channel_link_tokens admin_channel_link_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_channel_link_tokens
    ADD CONSTRAINT admin_channel_link_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: admin_communication_preferences admin_communication_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_communication_preferences
    ADD CONSTRAINT admin_communication_preferences_pkey PRIMARY KEY (admin_user_id);


--
-- Name: admin_nav_read_state admin_nav_read_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_nav_read_state
    ADD CONSTRAINT admin_nav_read_state_pkey PRIMARY KEY (admin_user_id, nav_key);


--
-- Name: admin_notification_preferences admin_notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences
    ADD CONSTRAINT admin_notification_preferences_pkey PRIMARY KEY (admin_user_id, event_type, channel);


--
-- Name: affiliate_credit_checkout_reservations affiliate_credit_checkout_reservations_checkout_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_checkout_reservations
    ADD CONSTRAINT affiliate_credit_checkout_reservations_checkout_intent_id_key UNIQUE (checkout_intent_id);


--
-- Name: affiliate_credit_checkout_reservations affiliate_credit_checkout_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_checkout_reservations
    ADD CONSTRAINT affiliate_credit_checkout_reservations_pkey PRIMARY KEY (id);


--
-- Name: affiliate_credit_ledger affiliate_credit_ledger_entry_type_reference_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_ledger
    ADD CONSTRAINT affiliate_credit_ledger_entry_type_reference_id_key UNIQUE (entry_type, reference_id);


--
-- Name: affiliate_credit_ledger affiliate_credit_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_ledger
    ADD CONSTRAINT affiliate_credit_ledger_pkey PRIMARY KEY (id);


--
-- Name: affiliate_profiles affiliate_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_profiles
    ADD CONSTRAINT affiliate_profiles_pkey PRIMARY KEY (customer_id);


--
-- Name: app_users app_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_email_key UNIQUE (email);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_username_key UNIQUE (username);


--
-- Name: arr_instances arr_instances_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arr_instances
    ADD CONSTRAINT arr_instances_name_key UNIQUE (name);


--
-- Name: arr_instances arr_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arr_instances
    ADD CONSTRAINT arr_instances_pkey PRIMARY KEY (id);


--
-- Name: arr_instances arr_instances_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arr_instances
    ADD CONSTRAINT arr_instances_slug_key UNIQUE (slug);


--
-- Name: attention_state attention_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_state
    ADD CONSTRAINT attention_state_pkey PRIMARY KEY (item_key);


--
-- Name: attention_workflow attention_workflow_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_workflow
    ADD CONSTRAINT attention_workflow_pkey PRIMARY KEY (fingerprint);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: auth_events auth_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_events
    ADD CONSTRAINT auth_events_pkey PRIMARY KEY (id);


--
-- Name: auth_recovery_codes auth_recovery_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_pkey PRIMARY KEY (id);


--
-- Name: auth_recovery_codes auth_recovery_codes_user_id_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_user_id_code_hash_key UNIQUE (user_id, code_hash);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: auth_totp_enrollments auth_totp_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_totp_enrollments
    ADD CONSTRAINT auth_totp_enrollments_pkey PRIMARY KEY (user_id);


--
-- Name: automation_job_state automation_job_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_job_state
    ADD CONSTRAINT automation_job_state_pkey PRIMARY KEY (job_key);


--
-- Name: background_job_items background_job_items_job_id_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_job_items
    ADD CONSTRAINT background_job_items_job_id_customer_id_key UNIQUE (job_id, customer_id);


--
-- Name: background_job_items background_job_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_job_items
    ADD CONSTRAINT background_job_items_pkey PRIMARY KEY (id);


--
-- Name: background_jobs background_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_jobs
    ADD CONSTRAINT background_jobs_pkey PRIMARY KEY (id);


--
-- Name: backup_runs backup_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_runs
    ADD CONSTRAINT backup_runs_pkey PRIMARY KEY (id);


--
-- Name: backup_verification_requests backup_verification_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_verification_requests
    ADD CONSTRAINT backup_verification_requests_pkey PRIMARY KEY (id);


--
-- Name: backup_worker_state backup_worker_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_worker_state
    ADD CONSTRAINT backup_worker_state_pkey PRIMARY KEY (worker_key);


--
-- Name: billing_checkout_intents billing_checkout_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_checkout_intents
    ADD CONSTRAINT billing_checkout_intents_pkey PRIMARY KEY (id);


--
-- Name: branding_assets branding_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_assets
    ADD CONSTRAINT branding_assets_pkey PRIMARY KEY (kind);


--
-- Name: content_requests content_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_requests
    ADD CONSTRAINT content_requests_pkey PRIMARY KEY (id);


--
-- Name: customer_access_holds customer_access_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_access_holds
    ADD CONSTRAINT customer_access_holds_pkey PRIMARY KEY (id);


--
-- Name: customer_account_claims customer_account_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_account_claims
    ADD CONSTRAINT customer_account_claims_pkey PRIMARY KEY (id);


--
-- Name: customer_account_claims customer_account_claims_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_account_claims
    ADD CONSTRAINT customer_account_claims_token_hash_key UNIQUE (token_hash);


--
-- Name: customer_bans customer_bans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_bans
    ADD CONSTRAINT customer_bans_pkey PRIMARY KEY (id);


--
-- Name: customer_channel_link_tokens customer_channel_link_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_channel_link_tokens
    ADD CONSTRAINT customer_channel_link_tokens_pkey PRIMARY KEY (id);


--
-- Name: customer_channel_link_tokens customer_channel_link_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_channel_link_tokens
    ADD CONSTRAINT customer_channel_link_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: customer_communication_preferences customer_communication_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_communication_preferences
    ADD CONSTRAINT customer_communication_preferences_pkey PRIMARY KEY (customer_id);


--
-- Name: customer_download_events customer_download_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_download_events
    ADD CONSTRAINT customer_download_events_pkey PRIMARY KEY (id);


--
-- Name: customer_invitations customer_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_invitations
    ADD CONSTRAINT customer_invitations_pkey PRIMARY KEY (id);


--
-- Name: customer_invitations customer_invitations_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_invitations
    ADD CONSTRAINT customer_invitations_token_hash_key UNIQUE (token_hash);


--
-- Name: customer_library_overrides customer_library_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_library_overrides
    ADD CONSTRAINT customer_library_overrides_pkey PRIMARY KEY (customer_id, library_name);


--
-- Name: customer_library_selection customer_library_selection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_library_selection
    ADD CONSTRAINT customer_library_selection_pkey PRIMARY KEY (customer_id);


--
-- Name: customer_notification_preferences customer_notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_notification_preferences
    ADD CONSTRAINT customer_notification_preferences_pkey PRIMARY KEY (customer_id, event_type, channel);


--
-- Name: customer_plan_changes customer_plan_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_plan_changes
    ADD CONSTRAINT customer_plan_changes_pkey PRIMARY KEY (id);


--
-- Name: customer_policy_overrides customer_policy_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_policy_overrides
    ADD CONSTRAINT customer_policy_overrides_pkey PRIMARY KEY (customer_id);


--
-- Name: customer_provisioning_state customer_provisioning_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_provisioning_state
    ADD CONSTRAINT customer_provisioning_state_pkey PRIMARY KEY (customer_id);


--
-- Name: customer_server_migrations customer_server_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_server_migrations
    ADD CONSTRAINT customer_server_migrations_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: discount_checkout_reservations discount_checkout_reservations_checkout_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_checkout_reservations
    ADD CONSTRAINT discount_checkout_reservations_checkout_intent_id_key UNIQUE (checkout_intent_id);


--
-- Name: discount_checkout_reservations discount_checkout_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_checkout_reservations
    ADD CONSTRAINT discount_checkout_reservations_pkey PRIMARY KEY (id);


--
-- Name: discount_codes discount_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_codes
    ADD CONSTRAINT discount_codes_code_key UNIQUE (code);


--
-- Name: discount_codes discount_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_codes
    ADD CONSTRAINT discount_codes_pkey PRIMARY KEY (id);


--
-- Name: discount_redemptions discount_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_redemptions
    ADD CONSTRAINT discount_redemptions_pkey PRIMARY KEY (id);


--
-- Name: email_gateway_settings email_gateway_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_gateway_settings
    ADD CONSTRAINT email_gateway_settings_pkey PRIMARY KEY (id);


--
-- Name: free_access_registration_reservations free_access_registration_reservatio_pending_registration_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.free_access_registration_reservations
    ADD CONSTRAINT free_access_registration_reservatio_pending_registration_id_key UNIQUE (pending_registration_id);


--
-- Name: free_access_registration_reservations free_access_registration_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.free_access_registration_reservations
    ADD CONSTRAINT free_access_registration_reservations_pkey PRIMARY KEY (id);


--
-- Name: invitation_redemptions invitation_redemptions_invitation_id_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions
    ADD CONSTRAINT invitation_redemptions_invitation_id_customer_id_key UNIQUE (invitation_id, customer_id);


--
-- Name: invitation_redemptions invitation_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions
    ADD CONSTRAINT invitation_redemptions_pkey PRIMARY KEY (id);


--
-- Name: jellyfin_account_lifecycle jellyfin_account_lifecycle_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_account_lifecycle
    ADD CONSTRAINT jellyfin_account_lifecycle_account_id_key UNIQUE (account_id);


--
-- Name: jellyfin_account_lifecycle jellyfin_account_lifecycle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_account_lifecycle
    ADD CONSTRAINT jellyfin_account_lifecycle_pkey PRIMARY KEY (id);


--
-- Name: jellyfin_accounts jellyfin_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_accounts
    ADD CONSTRAINT jellyfin_accounts_pkey PRIMARY KEY (id);


--
-- Name: jellyfin_accounts jellyfin_accounts_server_id_jellyfin_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_accounts
    ADD CONSTRAINT jellyfin_accounts_server_id_jellyfin_user_id_key UNIQUE (server_id, jellyfin_user_id);


--
-- Name: jellyfin_accounts jellyfin_accounts_server_id_jellyfin_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_accounts
    ADD CONSTRAINT jellyfin_accounts_server_id_jellyfin_username_key UNIQUE (server_id, jellyfin_username);


--
-- Name: jellyfin_policy_drift jellyfin_policy_drift_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_policy_drift
    ADD CONSTRAINT jellyfin_policy_drift_pkey PRIMARY KEY (jellyfin_account_id);


--
-- Name: jellyfin_policy_reconciliation jellyfin_policy_reconciliation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_policy_reconciliation
    ADD CONSTRAINT jellyfin_policy_reconciliation_pkey PRIMARY KEY (jellyfin_account_id);


--
-- Name: jellyfin_server_metrics jellyfin_server_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_server_metrics
    ADD CONSTRAINT jellyfin_server_metrics_pkey PRIMARY KEY (server_id);


--
-- Name: jellyfin_servers jellyfin_servers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_servers
    ADD CONSTRAINT jellyfin_servers_name_key UNIQUE (name);


--
-- Name: jellyfin_servers jellyfin_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_servers
    ADD CONSTRAINT jellyfin_servers_pkey PRIMARY KEY (id);


--
-- Name: jellyfin_servers jellyfin_servers_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_servers
    ADD CONSTRAINT jellyfin_servers_slug_key UNIQUE (slug);


--
-- Name: login_rate_limits login_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_rate_limits
    ADD CONSTRAINT login_rate_limits_pkey PRIMARY KEY (bucket_key);


--
-- Name: notification_outbox notification_outbox_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_dedupe_key_key UNIQUE (dedupe_key);


--
-- Name: notification_outbox notification_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (event_type);


--
-- Name: operational_worker_state operational_worker_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_worker_state
    ADD CONSTRAINT operational_worker_state_pkey PRIMARY KEY (worker_key);


--
-- Name: payment_customers payment_customers_customer_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_customer_id_provider_key UNIQUE (customer_id, provider);


--
-- Name: payment_customers payment_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_pkey PRIMARY KEY (id);


--
-- Name: payment_customers payment_customers_provider_provider_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_provider_provider_customer_id_key UNIQUE (provider, provider_customer_id);


--
-- Name: payment_events payment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);


--
-- Name: payment_events payment_events_provider_provider_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_provider_provider_event_id_key UNIQUE (provider, provider_event_id);


--
-- Name: payment_incident_notes payment_incident_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_incident_notes
    ADD CONSTRAINT payment_incident_notes_pkey PRIMARY KEY (id);


--
-- Name: payment_incidents payment_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_incidents
    ADD CONSTRAINT payment_incidents_pkey PRIMARY KEY (id);


--
-- Name: payment_incidents payment_incidents_provider_provider_event_id_incident_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_incidents
    ADD CONSTRAINT payment_incidents_provider_provider_event_id_incident_type_key UNIQUE (provider, provider_event_id, incident_type);


--
-- Name: payment_provider_credentials payment_provider_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_credentials
    ADD CONSTRAINT payment_provider_credentials_pkey PRIMARY KEY (provider);


--
-- Name: pending_registrations pending_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_registrations
    ADD CONSTRAINT pending_registrations_pkey PRIMARY KEY (id);


--
-- Name: pending_registrations pending_registrations_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_registrations
    ADD CONSTRAINT pending_registrations_token_hash_key UNIQUE (token_hash);


--
-- Name: plan_prices plan_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_prices
    ADD CONSTRAINT plan_prices_pkey PRIMARY KEY (id);


--
-- Name: plan_prices plan_prices_plan_id_currency_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_prices
    ADD CONSTRAINT plan_prices_plan_id_currency_key UNIQUE (plan_id, currency);


--
-- Name: plan_provider_prices plan_provider_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_provider_prices
    ADD CONSTRAINT plan_provider_prices_pkey PRIMARY KEY (id);


--
-- Name: plan_provider_prices plan_provider_prices_provider_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_provider_prices
    ADD CONSTRAINT plan_provider_prices_provider_external_id_key UNIQUE (provider, external_id);


--
-- Name: plan_server_eligibility plan_server_eligibility_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_server_eligibility
    ADD CONSTRAINT plan_server_eligibility_pkey PRIMARY KEY (plan_id, server_id);


--
-- Name: plan_stremio_sources plan_stremio_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_stremio_sources
    ADD CONSTRAINT plan_stremio_sources_pkey PRIMARY KEY (plan_id, source_id);


--
-- Name: plans plans_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_code_key UNIQUE (code);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: platform_settings platform_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (setting_key);


--
-- Name: playback_history playback_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history
    ADD CONSTRAINT playback_history_pkey PRIMARY KEY (id);


--
-- Name: playback_history playback_history_server_id_playback_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history
    ADD CONSTRAINT playback_history_server_id_playback_key_key UNIQUE (server_id, playback_key);


--
-- Name: provider_operations provider_operations_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_operations
    ADD CONSTRAINT provider_operations_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: provider_operations provider_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_operations
    ADD CONSTRAINT provider_operations_pkey PRIMARY KEY (id);


--
-- Name: provisioning_runs provisioning_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_runs
    ADD CONSTRAINT provisioning_runs_pkey PRIMARY KEY (id);


--
-- Name: referral_codes referral_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_code_key UNIQUE (code);


--
-- Name: referral_codes referral_codes_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_customer_id_key UNIQUE (customer_id);


--
-- Name: referral_codes referral_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_pkey PRIMARY KEY (id);


--
-- Name: referral_redemptions referral_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_redemptions
    ADD CONSTRAINT referral_redemptions_pkey PRIMARY KEY (id);


--
-- Name: referral_redemptions referral_redemptions_referred_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_redemptions
    ADD CONSTRAINT referral_redemptions_referred_customer_id_key UNIQUE (referred_customer_id);


--
-- Name: referral_reward_reversals referral_reward_reversals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_reward_reversals
    ADD CONSTRAINT referral_reward_reversals_pkey PRIMARY KEY (id);


--
-- Name: referral_reward_reversals referral_reward_reversals_redemption_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_reward_reversals
    ADD CONSTRAINT referral_reward_reversals_redemption_id_key UNIQUE (redemption_id);


--
-- Name: referral_service_credits referral_service_credits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_service_credits
    ADD CONSTRAINT referral_service_credits_pkey PRIMARY KEY (id);


--
-- Name: referral_service_credits referral_service_credits_source_redemption_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_service_credits
    ADD CONSTRAINT referral_service_credits_source_redemption_id_key UNIQUE (source_redemption_id);


--
-- Name: request_quality_tiers request_quality_tiers_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_quality_tiers
    ADD CONSTRAINT request_quality_tiers_code_key UNIQUE (code);


--
-- Name: request_quality_tiers request_quality_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_quality_tiers
    ADD CONSTRAINT request_quality_tiers_pkey PRIMARY KEY (id);


--
-- Name: request_routes request_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_routes
    ADD CONSTRAINT request_routes_pkey PRIMARY KEY (id);


--
-- Name: request_routes request_routes_quality_tier_id_media_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_routes
    ADD CONSTRAINT request_routes_quality_tier_id_media_type_key UNIQUE (quality_tier_id, media_type);


--
-- Name: request_service_settings request_service_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_service_settings
    ADD CONSTRAINT request_service_settings_pkey PRIMARY KEY (id);


--
-- Name: request_user_sync request_user_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_user_sync
    ADD CONSTRAINT request_user_sync_pkey PRIMARY KEY (customer_id);


--
-- Name: stream_policy_events stream_policy_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_policy_events
    ADD CONSTRAINT stream_policy_events_pkey PRIMARY KEY (id);


--
-- Name: stremio_entitlements stremio_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_entitlements
    ADD CONSTRAINT stremio_entitlements_pkey PRIMARY KEY (id);


--
-- Name: stremio_entitlements stremio_entitlements_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_entitlements
    ADD CONSTRAINT stremio_entitlements_subscription_id_key UNIQUE (subscription_id);


--
-- Name: stremio_media_index stremio_media_index_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_media_index
    ADD CONSTRAINT stremio_media_index_pkey PRIMARY KEY (server_id, item_id);


--
-- Name: stremio_media_index_state stremio_media_index_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_media_index_state
    ADD CONSTRAINT stremio_media_index_state_pkey PRIMARY KEY (server_id);


--
-- Name: stremio_source_index_state stremio_source_index_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_index_state
    ADD CONSTRAINT stremio_source_index_state_pkey PRIMARY KEY (source_id);


--
-- Name: stremio_source_libraries stremio_source_libraries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_libraries
    ADD CONSTRAINT stremio_source_libraries_pkey PRIMARY KEY (source_id, library_id);


--
-- Name: stremio_source_media_index stremio_source_media_index_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_media_index
    ADD CONSTRAINT stremio_source_media_index_pkey PRIMARY KEY (source_id, item_id);


--
-- Name: stremio_source_playback_leases stremio_source_playback_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_playback_leases
    ADD CONSTRAINT stremio_source_playback_leases_pkey PRIMARY KEY (lease_hash);


--
-- Name: stremio_sources stremio_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_sources
    ADD CONSTRAINT stremio_sources_pkey PRIMARY KEY (id);


--
-- Name: stremio_stream_attribution stremio_stream_attribution_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_stream_attribution
    ADD CONSTRAINT stremio_stream_attribution_pkey PRIMARY KEY (id);


--
-- Name: subscription_provider_sync subscription_provider_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_provider_sync
    ADD CONSTRAINT subscription_provider_sync_pkey PRIMARY KEY (subscription_id);


--
-- Name: subscription_service_extension_events subscription_service_extension_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_service_extension_events
    ADD CONSTRAINT subscription_service_extension_events_pkey PRIMARY KEY (id);


--
-- Name: subscription_service_extension_events subscription_service_extension_events_source_reference_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_service_extension_events
    ADD CONSTRAINT subscription_service_extension_events_source_reference_id_key UNIQUE (source, reference_id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: account_activation_tokens_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_activation_tokens_expiry_idx ON public.account_activation_tokens USING btree (expires_at);


--
-- Name: account_activation_tokens_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX account_activation_tokens_one_active ON public.account_activation_tokens USING btree (user_id, purpose) WHERE ((used_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: account_tokens_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_tokens_lookup_idx ON public.account_tokens USING btree (token_type, token_hash) WHERE (consumed_at IS NULL);


--
-- Name: account_tokens_user_type_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_tokens_user_type_open_idx ON public.account_tokens USING btree (user_id, token_type, expires_at) WHERE (consumed_at IS NULL);


--
-- Name: active_playback_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX active_playback_customer_idx ON public.active_playback_sessions USING btree (customer_id);


--
-- Name: admin_channel_link_tokens_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_channel_link_tokens_lookup_idx ON public.admin_channel_link_tokens USING btree (channel, token_hash, expires_at) WHERE (used_at IS NULL);


--
-- Name: admin_comm_discord_user_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_comm_discord_user_unique ON public.admin_communication_preferences USING btree (discord_user_id) WHERE (discord_user_id IS NOT NULL);


--
-- Name: admin_comm_telegram_chat_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_comm_telegram_chat_unique ON public.admin_communication_preferences USING btree (telegram_chat_id) WHERE (telegram_chat_id IS NOT NULL);


--
-- Name: admin_notification_preferences_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_notification_preferences_event_idx ON public.admin_notification_preferences USING btree (event_type, channel) WHERE (enabled = true);


--
-- Name: affiliate_credit_checkout_reservations_balance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX affiliate_credit_checkout_reservations_balance_idx ON public.affiliate_credit_checkout_reservations USING btree (customer_id, currency, state, expires_at);


--
-- Name: affiliate_credit_ledger_customer_currency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX affiliate_credit_ledger_customer_currency_idx ON public.affiliate_credit_ledger USING btree (customer_id, currency, state, created_at);


--
-- Name: affiliate_credit_ledger_referral_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX affiliate_credit_ledger_referral_idx ON public.affiliate_credit_ledger USING btree (referral_redemption_id);


--
-- Name: app_users_role_legacy_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_users_role_legacy_id_unique ON public.app_users USING btree (role, legacy_numeric_id) WHERE ((legacy_numeric_id IS NOT NULL) AND (role = 'admin'::text));


--
-- Name: attention_state_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attention_state_status_idx ON public.attention_state USING btree (status, updated_at DESC);


--
-- Name: attention_workflow_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attention_workflow_assignee_idx ON public.attention_workflow USING btree (assigned_to) WHERE (cleared_at IS NULL);


--
-- Name: attention_workflow_fingerprint_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX attention_workflow_fingerprint_unique_idx ON public.attention_workflow USING btree (fingerprint);


--
-- Name: attention_workflow_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attention_workflow_open_idx ON public.attention_workflow USING btree (cleared_at, severity, last_seen_at DESC);


--
-- Name: auth_events_type_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_events_type_created_idx ON public.auth_events USING btree (event_type, created_at DESC);


--
-- Name: auth_events_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_events_user_created_idx ON public.auth_events USING btree (user_id, created_at DESC);


--
-- Name: auth_recovery_codes_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_recovery_codes_active_idx ON public.auth_recovery_codes USING btree (user_id) WHERE (used_at IS NULL);


--
-- Name: auth_sessions_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_user_active_idx ON public.auth_sessions USING btree (user_id, last_seen_at DESC) WHERE (revoked_at IS NULL);


--
-- Name: background_job_items_job_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX background_job_items_job_status_idx ON public.background_job_items USING btree (job_id, status);


--
-- Name: background_job_items_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX background_job_items_pending_idx ON public.background_job_items USING btree (status, id) WHERE (status = 'pending'::text);


--
-- Name: background_job_items_running_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX background_job_items_running_idx ON public.background_job_items USING btree (status, updated_at) WHERE (status = 'running'::text);


--
-- Name: background_jobs_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX background_jobs_created_by_idx ON public.background_jobs USING btree (created_by, created_at DESC);


--
-- Name: background_jobs_idempotency_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX background_jobs_idempotency_unique ON public.background_jobs USING btree (created_by, idempotency_key) NULLS NOT DISTINCT WHERE (idempotency_key IS NOT NULL);


--
-- Name: background_jobs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX background_jobs_status_idx ON public.background_jobs USING btree (status, created_at);


--
-- Name: backup_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_runs_started_idx ON public.backup_runs USING btree (started_at DESC);


--
-- Name: backup_runs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_runs_status_idx ON public.backup_runs USING btree (status, started_at DESC);


--
-- Name: backup_verification_requests_active_backup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX backup_verification_requests_active_backup_idx ON public.backup_verification_requests USING btree (backup_run_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: backup_verification_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_verification_requests_status_idx ON public.backup_verification_requests USING btree (status, requested_at);


--
-- Name: branding_assets_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branding_assets_updated_idx ON public.branding_assets USING btree (updated_at DESC);


--
-- Name: checkout_intents_customer_open_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX checkout_intents_customer_open_unique ON public.billing_checkout_intents USING btree (customer_id) WHERE ((scope = 'customer'::text) AND (state = 'open'::text));


--
-- Name: checkout_intents_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checkout_intents_expiry_idx ON public.billing_checkout_intents USING btree (state, expires_at);


--
-- Name: checkout_intents_provider_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX checkout_intents_provider_unique ON public.billing_checkout_intents USING btree (provider, provider_checkout_id) WHERE (provider_checkout_id IS NOT NULL);


--
-- Name: content_requests_arr_tracking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_requests_arr_tracking_idx ON public.content_requests USING btree (arr_instance_id, arr_item_id) WHERE ((arr_instance_id IS NOT NULL) AND (arr_item_id IS NOT NULL));


--
-- Name: content_requests_customer_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_requests_customer_created_idx ON public.content_requests USING btree (customer_id, created_at DESC);


--
-- Name: content_requests_tmdb_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_requests_tmdb_idx ON public.content_requests USING btree (media_type, tmdb_id);


--
-- Name: customer_access_holds_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_access_holds_active_unique ON public.customer_access_holds USING btree (customer_id, hold_type, source_key) WHERE (released_at IS NULL);


--
-- Name: customer_access_holds_customer_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_access_holds_customer_active_idx ON public.customer_access_holds USING btree (customer_id, created_at) WHERE (released_at IS NULL);


--
-- Name: customer_account_claims_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_account_claims_active_idx ON public.customer_account_claims USING btree (expires_at) WHERE ((consumed_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: customer_account_claims_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_account_claims_customer_idx ON public.customer_account_claims USING btree (customer_id, created_at DESC);


--
-- Name: customer_bans_customer_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_bans_customer_active_idx ON public.customer_bans USING btree (customer_id) WHERE (revoked_at IS NULL);


--
-- Name: customer_bans_email_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_bans_email_active_idx ON public.customer_bans USING btree (normalized_email) WHERE ((revoked_at IS NULL) AND (normalized_email IS NOT NULL));


--
-- Name: customer_channel_link_tokens_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_channel_link_tokens_customer_idx ON public.customer_channel_link_tokens USING btree (customer_id, channel, created_at DESC);


--
-- Name: customer_channel_link_tokens_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_channel_link_tokens_lookup_idx ON public.customer_channel_link_tokens USING btree (channel, token_hash, expires_at) WHERE (used_at IS NULL);


--
-- Name: customer_comm_discord_user_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_comm_discord_user_unique ON public.customer_communication_preferences USING btree (discord_user_id) WHERE (discord_user_id IS NOT NULL);


--
-- Name: customer_comm_telegram_chat_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_comm_telegram_chat_unique ON public.customer_communication_preferences USING btree (telegram_chat_id) WHERE (telegram_chat_id IS NOT NULL);


--
-- Name: customer_download_events_customer_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_download_events_customer_created_idx ON public.customer_download_events USING btree (customer_id, created_at DESC);


--
-- Name: customer_download_events_server_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_download_events_server_created_idx ON public.customer_download_events USING btree (server_id, created_at DESC);


--
-- Name: customer_invitations_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_invitations_expiry_idx ON public.customer_invitations USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: customer_invitations_plan_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_invitations_plan_idx ON public.customer_invitations USING btree (plan_id, created_at DESC);


--
-- Name: customer_notification_preferences_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_notification_preferences_event_idx ON public.customer_notification_preferences USING btree (event_type, channel) WHERE (enabled = true);


--
-- Name: customer_plan_changes_one_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_plan_changes_one_pending ON public.customer_plan_changes USING btree (customer_id) WHERE (state = 'pending'::text);


--
-- Name: customer_plan_changes_provider_schedule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_plan_changes_provider_schedule_idx ON public.customer_plan_changes USING btree (provider, provider_schedule_id) WHERE (provider_schedule_id IS NOT NULL);


--
-- Name: customer_provisioning_state_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_provisioning_state_due_idx ON public.customer_provisioning_state USING btree (next_attempt_at, status);


--
-- Name: customer_provisioning_state_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_provisioning_state_status_idx ON public.customer_provisioning_state USING btree (status, updated_at DESC);


--
-- Name: customer_server_migrations_one_open_per_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_server_migrations_one_open_per_customer ON public.customer_server_migrations USING btree (customer_id) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));


--
-- Name: customer_server_migrations_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_server_migrations_recent_idx ON public.customer_server_migrations USING btree (requested_at DESC);


--
-- Name: customer_server_migrations_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_server_migrations_target_idx ON public.customer_server_migrations USING btree (target_server_id, status);


--
-- Name: customers_discord_user_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customers_discord_user_unique ON public.customers USING btree (discord_user_id) WHERE ((discord_user_id IS NOT NULL) AND (discord_user_id <> ''::text));


--
-- Name: customers_user_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customers_user_unique ON public.customers USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: discount_checkout_reservations_code_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discount_checkout_reservations_code_open_idx ON public.discount_checkout_reservations USING btree (discount_code_id, expires_at) WHERE (state = 'reserved'::text);


--
-- Name: discount_checkout_reservations_customer_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discount_checkout_reservations_customer_open_idx ON public.discount_checkout_reservations USING btree (customer_id, discount_code_id) WHERE (state = 'reserved'::text);


--
-- Name: discount_redemptions_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discount_redemptions_code_idx ON public.discount_redemptions USING btree (discount_code_id);


--
-- Name: discount_redemptions_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discount_redemptions_customer_idx ON public.discount_redemptions USING btree (customer_id);


--
-- Name: discount_redemptions_subscription_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX discount_redemptions_subscription_unique ON public.discount_redemptions USING btree (subscription_id) WHERE (subscription_id IS NOT NULL);


--
-- Name: free_access_registration_reservations_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX free_access_registration_reservations_email_idx ON public.free_access_registration_reservations USING btree (normalized_email, expires_at);


--
-- Name: free_access_registration_reservations_plan_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX free_access_registration_reservations_plan_expiry_idx ON public.free_access_registration_reservations USING btree (plan_id, expires_at);


--
-- Name: invitation_redemptions_invitation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitation_redemptions_invitation_idx ON public.invitation_redemptions USING btree (invitation_id, redeemed_at DESC);


--
-- Name: jellyfin_account_lifecycle_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_account_lifecycle_customer_idx ON public.jellyfin_account_lifecycle USING btree (customer_id, updated_at DESC);


--
-- Name: jellyfin_account_lifecycle_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_account_lifecycle_due_idx ON public.jellyfin_account_lifecycle USING btree (delete_after) WHERE ((deleted_at IS NULL) AND (restored_at IS NULL));


--
-- Name: jellyfin_accounts_one_primary_per_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jellyfin_accounts_one_primary_per_customer ON public.jellyfin_accounts USING btree (customer_id) WHERE (is_primary = true);


--
-- Name: jellyfin_accounts_password_setup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_accounts_password_setup_idx ON public.jellyfin_accounts USING btree (customer_id) WHERE (password_setup_required = true);


--
-- Name: jellyfin_accounts_stremio_internal_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jellyfin_accounts_stremio_internal_unique ON public.jellyfin_accounts USING btree (customer_id, server_id) WHERE (account_purpose = 'stremio_internal'::text);


--
-- Name: jellyfin_policy_drift_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_policy_drift_customer_idx ON public.jellyfin_policy_drift USING btree (customer_id);


--
-- Name: jellyfin_policy_drift_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_policy_drift_due_idx ON public.jellyfin_policy_drift USING btree (next_check_at, status);


--
-- Name: jellyfin_policy_drift_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_policy_drift_status_idx ON public.jellyfin_policy_drift USING btree (status, updated_at DESC);


--
-- Name: jellyfin_policy_reconciliation_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_policy_reconciliation_customer_idx ON public.jellyfin_policy_reconciliation USING btree (customer_id);


--
-- Name: jellyfin_policy_reconciliation_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_policy_reconciliation_retry_idx ON public.jellyfin_policy_reconciliation USING btree (next_retry_at, status) WHERE (status = 'failed'::text);


--
-- Name: jellyfin_policy_reconciliation_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_policy_reconciliation_status_idx ON public.jellyfin_policy_reconciliation USING btree (status, requested_at);


--
-- Name: jellyfin_server_metrics_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jellyfin_server_metrics_observed_idx ON public.jellyfin_server_metrics USING btree (observed_at DESC);


--
-- Name: login_rate_limits_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_rate_limits_updated_at_idx ON public.login_rate_limits USING btree (updated_at);


--
-- Name: notification_outbox_channel_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_outbox_channel_status_idx ON public.notification_outbox USING btree (channel, status, next_attempt_at);


--
-- Name: notification_outbox_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_outbox_due_idx ON public.notification_outbox USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: notification_outbox_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_outbox_recent_idx ON public.notification_outbox USING btree (created_at DESC);


--
-- Name: operational_worker_heartbeat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operational_worker_heartbeat_idx ON public.operational_worker_state USING btree (last_heartbeat_at DESC);


--
-- Name: payment_events_unprocessed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_events_unprocessed_idx ON public.payment_events USING btree (created_at) WHERE (processed_at IS NULL);


--
-- Name: payment_incident_notes_incident_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_incident_notes_incident_idx ON public.payment_incident_notes USING btree (incident_id, created_at DESC);


--
-- Name: payment_incidents_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_incidents_case_idx ON public.payment_incidents USING btree (provider, provider_case_id, created_at DESC);


--
-- Name: payment_incidents_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_incidents_customer_idx ON public.payment_incidents USING btree (customer_id, created_at DESC) WHERE (customer_id IS NOT NULL);


--
-- Name: pending_registrations_email_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pending_registrations_email_open_idx ON public.pending_registrations USING btree (lower(email)) WHERE (consumed_at IS NULL);


--
-- Name: pending_registrations_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_registrations_expiry_idx ON public.pending_registrations USING btree (expires_at) WHERE (consumed_at IS NULL);


--
-- Name: pending_registrations_username_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pending_registrations_username_open_idx ON public.pending_registrations USING btree (lower(username)) WHERE (consumed_at IS NULL);


--
-- Name: plan_prices_id_plan_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX plan_prices_id_plan_unique ON public.plan_prices USING btree (id, plan_id);


--
-- Name: plan_prices_one_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX plan_prices_one_default_idx ON public.plan_prices USING btree (plan_id) WHERE (is_default = true);


--
-- Name: plan_prices_sellable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plan_prices_sellable_idx ON public.plan_prices USING btree (plan_id, currency) WHERE (active = true);


--
-- Name: plan_provider_prices_plan_currency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plan_provider_prices_plan_currency_idx ON public.plan_provider_prices USING btree (plan_id, plan_price_id, provider, active);


--
-- Name: plan_provider_prices_plan_provider_mode_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX plan_provider_prices_plan_provider_mode_unique ON public.plan_provider_prices USING btree (plan_id, provider, checkout_mode);


--
-- Name: plan_provider_prices_price_provider_mode_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX plan_provider_prices_price_provider_mode_unique ON public.plan_provider_prices USING btree (plan_price_id, provider, checkout_mode);


--
-- Name: plan_server_eligibility_server_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plan_server_eligibility_server_idx ON public.plan_server_eligibility USING btree (server_id, plan_id);


--
-- Name: plan_stremio_sources_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plan_stremio_sources_source_idx ON public.plan_stremio_sources USING btree (source_id, plan_id) WHERE (enabled = true);


--
-- Name: plans_archived_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plans_archived_idx ON public.plans USING btree (archived_at) WHERE (archived_at IS NOT NULL);


--
-- Name: plans_single_free_tier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX plans_single_free_tier_idx ON public.plans USING btree (is_free_tier) WHERE (is_free_tier = true);


--
-- Name: plans_version_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plans_version_group_idx ON public.plans USING btree (version_group_id, version_number DESC);


--
-- Name: playback_history_customer_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playback_history_customer_started_idx ON public.playback_history USING btree (customer_id, started_at DESC);


--
-- Name: provider_operations_attention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_operations_attention_idx ON public.provider_operations USING btree (state, updated_at DESC) WHERE (state = ANY (ARRAY['planned'::text, 'provider_applied'::text, 'failed'::text]));


--
-- Name: provider_operations_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_operations_owner_idx ON public.provider_operations USING btree (scope, owner_id, created_at DESC);


--
-- Name: provisioning_runs_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provisioning_runs_customer_idx ON public.provisioning_runs USING btree (customer_id, started_at DESC);


--
-- Name: referral_redemptions_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX referral_redemptions_code_idx ON public.referral_redemptions USING btree (referral_code_id);


--
-- Name: referral_redemptions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX referral_redemptions_status_idx ON public.referral_redemptions USING btree (status);


--
-- Name: referral_reward_reversals_incident_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX referral_reward_reversals_incident_idx ON public.referral_reward_reversals USING btree (payment_incident_id);


--
-- Name: referral_service_credits_customer_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX referral_service_credits_customer_state_idx ON public.referral_service_credits USING btree (customer_id, state, created_at);


--
-- Name: request_routes_instance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_routes_instance_idx ON public.request_routes USING btree (arr_instance_id);


--
-- Name: request_user_sync_access_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_user_sync_access_idx ON public.request_user_sync USING btree (access_suspended, status);


--
-- Name: request_user_sync_external_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_user_sync_external_user_idx ON public.request_user_sync USING btree (external_user_id) WHERE (external_user_id IS NOT NULL);


--
-- Name: request_user_sync_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_user_sync_status_idx ON public.request_user_sync USING btree (status, updated_at DESC);


--
-- Name: stream_policy_events_customer_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stream_policy_events_customer_created_idx ON public.stream_policy_events USING btree (customer_id, created_at DESC);


--
-- Name: stream_policy_events_decision_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stream_policy_events_decision_created_idx ON public.stream_policy_events USING btree (decision, created_at DESC);


--
-- Name: stremio_entitlements_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_entitlements_customer_idx ON public.stremio_entitlements USING btree (customer_id, status);


--
-- Name: stremio_entitlements_server_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_entitlements_server_idx ON public.stremio_entitlements USING btree (server_id, status) WHERE (server_id IS NOT NULL);


--
-- Name: stremio_entitlements_token_hash_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stremio_entitlements_token_hash_unique ON public.stremio_entitlements USING btree (token_hash) WHERE (token_hash IS NOT NULL);


--
-- Name: stremio_media_index_imdb_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_media_index_imdb_idx ON public.stremio_media_index USING btree (server_id, imdb_id, item_type);


--
-- Name: stremio_source_libraries_selected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_source_libraries_selected_idx ON public.stremio_source_libraries USING btree (source_id, selected, available);


--
-- Name: stremio_source_media_imdb_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_source_media_imdb_idx ON public.stremio_source_media_index USING btree (source_id, imdb_id, item_type);


--
-- Name: stremio_source_media_library_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_source_media_library_idx ON public.stremio_source_media_index USING btree (source_id, library_id);


--
-- Name: stremio_source_playback_leases_entitlement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_source_playback_leases_entitlement_idx ON public.stremio_source_playback_leases USING btree (entitlement_id, expires_at);


--
-- Name: stremio_source_playback_leases_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_source_playback_leases_expiry_idx ON public.stremio_source_playback_leases USING btree (expires_at);


--
-- Name: stremio_sources_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_sources_enabled_idx ON public.stremio_sources USING btree (enabled, priority, name);


--
-- Name: stremio_stream_attribution_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_stream_attribution_customer_idx ON public.stremio_stream_attribution USING btree (customer_id, requested_at DESC);


--
-- Name: stremio_stream_attribution_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stremio_stream_attribution_source_idx ON public.stremio_stream_attribution USING btree (source_id, requested_at DESC);


--
-- Name: subscription_provider_sync_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscription_provider_sync_due_idx ON public.subscription_provider_sync USING btree (next_attempt_at) WHERE ((last_error IS NOT NULL) OR (next_attempt_at IS NOT NULL));


--
-- Name: subscription_service_extension_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscription_service_extension_customer_idx ON public.subscription_service_extension_events USING btree (customer_id, created_at DESC);


--
-- Name: subscriptions_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_customer_idx ON public.subscriptions USING btree (customer_id);


--
-- Name: subscriptions_effective_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_effective_customer_idx ON public.subscriptions USING btree (customer_id, current_period_end DESC, created_at DESC) WHERE (superseded_by IS NULL);


--
-- Name: subscriptions_entitlement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_entitlement_idx ON public.subscriptions USING btree (customer_id, current_period_end DESC) WHERE (status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text]));


--
-- Name: subscriptions_plan_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_plan_status_idx ON public.subscriptions USING btree (plan_id, status, current_period_end DESC);


--
-- Name: subscriptions_provider_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscriptions_provider_unique ON public.subscriptions USING btree (source, provider_subscription_id) WHERE (provider_subscription_id IS NOT NULL);


--
-- Name: subscriptions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_status_idx ON public.subscriptions USING btree (status);


--
-- Name: app_users assign_native_staff_compatibility_id_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assign_native_staff_compatibility_id_trigger BEFORE INSERT OR UPDATE OF role ON public.app_users FOR EACH ROW EXECUTE FUNCTION public.assign_native_staff_compatibility_id();


--
-- Name: audit_log audit_log_append_only_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_append_only_trigger BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.protect_audit_log_history();


--
-- Name: jellyfin_accounts mark_fresh_jellyfin_password_setup_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mark_fresh_jellyfin_password_setup_trigger BEFORE INSERT ON public.jellyfin_accounts FOR EACH ROW EXECUTE FUNCTION public.mark_fresh_jellyfin_password_setup();


--
-- Name: plan_provider_prices plan_provider_prices_bind_legacy_price; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER plan_provider_prices_bind_legacy_price BEFORE INSERT OR UPDATE OF plan_id, plan_price_id ON public.plan_provider_prices FOR EACH ROW EXECUTE FUNCTION public.bind_legacy_provider_mapping_price();


--
-- Name: plans plans_ensure_default_price_after_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER plans_ensure_default_price_after_insert AFTER INSERT ON public.plans FOR EACH ROW EXECUTE FUNCTION public.ensure_plan_default_price_after_insert();


--
-- Name: plan_prices protect_canonical_free_tier_price_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protect_canonical_free_tier_price_trigger BEFORE DELETE OR UPDATE ON public.plan_prices FOR EACH ROW EXECUTE FUNCTION public.protect_canonical_free_tier_price();


--
-- Name: plans protect_canonical_free_tier_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protect_canonical_free_tier_trigger BEFORE DELETE OR UPDATE ON public.plans FOR EACH ROW EXECUTE FUNCTION public.protect_canonical_free_tier();


--
-- Name: subscriptions single_live_customer_recurring_subscription_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER single_live_customer_recurring_subscription_trigger BEFORE INSERT OR UPDATE OF customer_id, plan_id, status, source, current_period_end, provider_subscription_id, superseded_by ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.enforce_single_live_customer_recurring_subscription();


--
-- Name: subscriptions snapshot_subscription_plan_terms_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER snapshot_subscription_plan_terms_trigger BEFORE INSERT OR UPDATE OF plan_id ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.snapshot_subscription_plan_terms();


--
-- Name: stremio_entitlements stremio_entitlement_integrity_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stremio_entitlement_integrity_trigger BEFORE INSERT OR UPDATE ON public.stremio_entitlements FOR EACH ROW EXECUTE FUNCTION public.enforce_stremio_entitlement_integrity();


--
-- Name: subscriptions subscriptions_multicurrency_contract_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subscriptions_multicurrency_contract_snapshot BEFORE INSERT OR UPDATE OF commercial_snapshot, provider_price_id_snapshot ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.snapshot_subscription_multicurrency_contract();


--
-- Name: plan_provider_prices trg_reset_direct_provider_mapping_validation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reset_direct_provider_mapping_validation BEFORE INSERT OR UPDATE OF provider, external_id, checkout_mode ON public.plan_provider_prices FOR EACH ROW EXECUTE FUNCTION public.reset_direct_provider_mapping_validation();


--
-- Name: account_activation_tokens account_activation_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_activation_tokens
    ADD CONSTRAINT account_activation_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: account_activation_tokens account_activation_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_activation_tokens
    ADD CONSTRAINT account_activation_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: account_tokens account_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_tokens
    ADD CONSTRAINT account_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: active_playback_sessions active_playback_sessions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_playback_sessions
    ADD CONSTRAINT active_playback_sessions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: active_playback_sessions active_playback_sessions_jellyfin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_playback_sessions
    ADD CONSTRAINT active_playback_sessions_jellyfin_account_id_fkey FOREIGN KEY (jellyfin_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE CASCADE;


--
-- Name: active_playback_sessions active_playback_sessions_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_playback_sessions
    ADD CONSTRAINT active_playback_sessions_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE CASCADE;


--
-- Name: admin_channel_link_tokens admin_channel_link_tokens_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_channel_link_tokens
    ADD CONSTRAINT admin_channel_link_tokens_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: admin_communication_preferences admin_communication_preferences_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_communication_preferences
    ADD CONSTRAINT admin_communication_preferences_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: admin_nav_read_state admin_nav_read_state_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_nav_read_state
    ADD CONSTRAINT admin_nav_read_state_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: admin_notification_preferences admin_notification_preferences_admin_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences
    ADD CONSTRAINT admin_notification_preferences_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: affiliate_credit_checkout_reservations affiliate_credit_checkout_reservations_checkout_intent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_checkout_reservations
    ADD CONSTRAINT affiliate_credit_checkout_reservations_checkout_intent_id_fkey FOREIGN KEY (checkout_intent_id) REFERENCES public.billing_checkout_intents(id) ON DELETE CASCADE;


--
-- Name: affiliate_credit_checkout_reservations affiliate_credit_checkout_reservations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_checkout_reservations
    ADD CONSTRAINT affiliate_credit_checkout_reservations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: affiliate_credit_ledger affiliate_credit_ledger_applied_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_ledger
    ADD CONSTRAINT affiliate_credit_ledger_applied_subscription_id_fkey FOREIGN KEY (applied_subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: affiliate_credit_ledger affiliate_credit_ledger_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_ledger
    ADD CONSTRAINT affiliate_credit_ledger_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: affiliate_credit_ledger affiliate_credit_ledger_payment_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_ledger
    ADD CONSTRAINT affiliate_credit_ledger_payment_incident_id_fkey FOREIGN KEY (payment_incident_id) REFERENCES public.payment_incidents(id) ON DELETE SET NULL;


--
-- Name: affiliate_credit_ledger affiliate_credit_ledger_qualifying_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_ledger
    ADD CONSTRAINT affiliate_credit_ledger_qualifying_subscription_id_fkey FOREIGN KEY (qualifying_subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: affiliate_credit_ledger affiliate_credit_ledger_referral_redemption_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_ledger
    ADD CONSTRAINT affiliate_credit_ledger_referral_redemption_id_fkey FOREIGN KEY (referral_redemption_id) REFERENCES public.referral_redemptions(id) ON DELETE SET NULL;


--
-- Name: affiliate_credit_ledger affiliate_credit_ledger_referred_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_credit_ledger
    ADD CONSTRAINT affiliate_credit_ledger_referred_customer_id_fkey FOREIGN KEY (referred_customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: affiliate_profiles affiliate_profiles_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_profiles
    ADD CONSTRAINT affiliate_profiles_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: attention_state attention_state_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_state
    ADD CONSTRAINT attention_state_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: attention_state attention_state_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_state
    ADD CONSTRAINT attention_state_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: attention_state attention_state_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_state
    ADD CONSTRAINT attention_state_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: attention_workflow attention_workflow_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_workflow
    ADD CONSTRAINT attention_workflow_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: attention_workflow attention_workflow_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_workflow
    ADD CONSTRAINT attention_workflow_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: auth_events auth_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_events
    ADD CONSTRAINT auth_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: auth_recovery_codes auth_recovery_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: auth_totp_enrollments auth_totp_enrollments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_totp_enrollments
    ADD CONSTRAINT auth_totp_enrollments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: background_job_items background_job_items_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_job_items
    ADD CONSTRAINT background_job_items_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: background_job_items background_job_items_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_job_items
    ADD CONSTRAINT background_job_items_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.background_jobs(id) ON DELETE CASCADE;


--
-- Name: background_jobs background_jobs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_jobs
    ADD CONSTRAINT background_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: backup_verification_requests backup_verification_requests_backup_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_verification_requests
    ADD CONSTRAINT backup_verification_requests_backup_run_id_fkey FOREIGN KEY (backup_run_id) REFERENCES public.backup_runs(id) ON DELETE CASCADE;


--
-- Name: backup_verification_requests backup_verification_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_verification_requests
    ADD CONSTRAINT backup_verification_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: billing_checkout_intents billing_checkout_intents_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_checkout_intents
    ADD CONSTRAINT billing_checkout_intents_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: billing_checkout_intents billing_checkout_intents_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_checkout_intents
    ADD CONSTRAINT billing_checkout_intents_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;


--
-- Name: billing_checkout_intents billing_checkout_intents_plan_price_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_checkout_intents
    ADD CONSTRAINT billing_checkout_intents_plan_price_id_fkey FOREIGN KEY (plan_price_id) REFERENCES public.plan_prices(id) ON DELETE SET NULL;


--
-- Name: branding_assets branding_assets_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_assets
    ADD CONSTRAINT branding_assets_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: content_requests content_requests_arr_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_requests
    ADD CONSTRAINT content_requests_arr_instance_id_fkey FOREIGN KEY (arr_instance_id) REFERENCES public.arr_instances(id) ON DELETE SET NULL;


--
-- Name: content_requests content_requests_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_requests
    ADD CONSTRAINT content_requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: content_requests content_requests_quality_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_requests
    ADD CONSTRAINT content_requests_quality_tier_id_fkey FOREIGN KEY (quality_tier_id) REFERENCES public.request_quality_tiers(id) ON DELETE SET NULL;


--
-- Name: customer_access_holds customer_access_holds_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_access_holds
    ADD CONSTRAINT customer_access_holds_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_access_holds customer_access_holds_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_access_holds
    ADD CONSTRAINT customer_access_holds_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_access_holds customer_access_holds_released_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_access_holds
    ADD CONSTRAINT customer_access_holds_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_account_claims customer_account_claims_claimed_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_account_claims
    ADD CONSTRAINT customer_account_claims_claimed_user_id_fkey FOREIGN KEY (claimed_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_account_claims customer_account_claims_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_account_claims
    ADD CONSTRAINT customer_account_claims_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_account_claims customer_account_claims_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_account_claims
    ADD CONSTRAINT customer_account_claims_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_bans customer_bans_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_bans
    ADD CONSTRAINT customer_bans_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_bans customer_bans_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_bans
    ADD CONSTRAINT customer_bans_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: customer_bans customer_bans_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_bans
    ADD CONSTRAINT customer_bans_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_channel_link_tokens customer_channel_link_tokens_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_channel_link_tokens
    ADD CONSTRAINT customer_channel_link_tokens_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_communication_preferences customer_communication_preferences_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_communication_preferences
    ADD CONSTRAINT customer_communication_preferences_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_download_events customer_download_events_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_download_events
    ADD CONSTRAINT customer_download_events_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: customer_download_events customer_download_events_jellyfin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_download_events
    ADD CONSTRAINT customer_download_events_jellyfin_account_id_fkey FOREIGN KEY (jellyfin_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE SET NULL;


--
-- Name: customer_download_events customer_download_events_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_download_events
    ADD CONSTRAINT customer_download_events_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE SET NULL;


--
-- Name: customer_invitations customer_invitations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_invitations
    ADD CONSTRAINT customer_invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_invitations customer_invitations_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_invitations
    ADD CONSTRAINT customer_invitations_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE RESTRICT;


--
-- Name: customer_library_overrides customer_library_overrides_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_library_overrides
    ADD CONSTRAINT customer_library_overrides_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_library_overrides customer_library_overrides_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_library_overrides
    ADD CONSTRAINT customer_library_overrides_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_library_selection customer_library_selection_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_library_selection
    ADD CONSTRAINT customer_library_selection_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_notification_preferences customer_notification_preferences_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_notification_preferences
    ADD CONSTRAINT customer_notification_preferences_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_plan_changes customer_plan_changes_current_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_plan_changes
    ADD CONSTRAINT customer_plan_changes_current_subscription_id_fkey FOREIGN KEY (current_subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: customer_plan_changes customer_plan_changes_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_plan_changes
    ADD CONSTRAINT customer_plan_changes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_plan_changes customer_plan_changes_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_plan_changes
    ADD CONSTRAINT customer_plan_changes_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_plan_changes customer_plan_changes_target_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_plan_changes
    ADD CONSTRAINT customer_plan_changes_target_plan_id_fkey FOREIGN KEY (target_plan_id) REFERENCES public.plans(id) ON DELETE RESTRICT;


--
-- Name: customer_policy_overrides customer_policy_overrides_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_policy_overrides
    ADD CONSTRAINT customer_policy_overrides_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_policy_overrides customer_policy_overrides_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_policy_overrides
    ADD CONSTRAINT customer_policy_overrides_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_provisioning_state customer_provisioning_state_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_provisioning_state
    ADD CONSTRAINT customer_provisioning_state_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_provisioning_state customer_provisioning_state_jellyfin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_provisioning_state
    ADD CONSTRAINT customer_provisioning_state_jellyfin_account_id_fkey FOREIGN KEY (jellyfin_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE SET NULL;


--
-- Name: customer_provisioning_state customer_provisioning_state_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_provisioning_state
    ADD CONSTRAINT customer_provisioning_state_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;


--
-- Name: customer_provisioning_state customer_provisioning_state_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_provisioning_state
    ADD CONSTRAINT customer_provisioning_state_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE SET NULL;


--
-- Name: customer_provisioning_state customer_provisioning_state_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_provisioning_state
    ADD CONSTRAINT customer_provisioning_state_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: customer_server_migrations customer_server_migrations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_server_migrations
    ADD CONSTRAINT customer_server_migrations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_server_migrations customer_server_migrations_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_server_migrations
    ADD CONSTRAINT customer_server_migrations_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customer_server_migrations customer_server_migrations_source_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_server_migrations
    ADD CONSTRAINT customer_server_migrations_source_account_id_fkey FOREIGN KEY (source_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE RESTRICT;


--
-- Name: customer_server_migrations customer_server_migrations_source_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_server_migrations
    ADD CONSTRAINT customer_server_migrations_source_server_id_fkey FOREIGN KEY (source_server_id) REFERENCES public.jellyfin_servers(id) ON DELETE RESTRICT;


--
-- Name: customer_server_migrations customer_server_migrations_target_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_server_migrations
    ADD CONSTRAINT customer_server_migrations_target_account_id_fkey FOREIGN KEY (target_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE SET NULL;


--
-- Name: customer_server_migrations customer_server_migrations_target_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_server_migrations
    ADD CONSTRAINT customer_server_migrations_target_server_id_fkey FOREIGN KEY (target_server_id) REFERENCES public.jellyfin_servers(id) ON DELETE RESTRICT;


--
-- Name: customers customers_automation_protected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_automation_protected_by_fkey FOREIGN KEY (automation_protected_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customers customers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: discount_checkout_reservations discount_checkout_reservations_checkout_intent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_checkout_reservations
    ADD CONSTRAINT discount_checkout_reservations_checkout_intent_id_fkey FOREIGN KEY (checkout_intent_id) REFERENCES public.billing_checkout_intents(id) ON DELETE CASCADE;


--
-- Name: discount_checkout_reservations discount_checkout_reservations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_checkout_reservations
    ADD CONSTRAINT discount_checkout_reservations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: discount_checkout_reservations discount_checkout_reservations_discount_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_checkout_reservations
    ADD CONSTRAINT discount_checkout_reservations_discount_code_id_fkey FOREIGN KEY (discount_code_id) REFERENCES public.discount_codes(id) ON DELETE CASCADE;


--
-- Name: discount_codes discount_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_codes
    ADD CONSTRAINT discount_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: discount_redemptions discount_redemptions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_redemptions
    ADD CONSTRAINT discount_redemptions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: discount_redemptions discount_redemptions_discount_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_redemptions
    ADD CONSTRAINT discount_redemptions_discount_code_id_fkey FOREIGN KEY (discount_code_id) REFERENCES public.discount_codes(id) ON DELETE CASCADE;


--
-- Name: discount_redemptions discount_redemptions_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_redemptions
    ADD CONSTRAINT discount_redemptions_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: email_gateway_settings email_gateway_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_gateway_settings
    ADD CONSTRAINT email_gateway_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: free_access_registration_reservations free_access_registration_reservati_pending_registration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.free_access_registration_reservations
    ADD CONSTRAINT free_access_registration_reservati_pending_registration_id_fkey FOREIGN KEY (pending_registration_id) REFERENCES public.pending_registrations(id) ON DELETE CASCADE;


--
-- Name: free_access_registration_reservations free_access_registration_reservations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.free_access_registration_reservations
    ADD CONSTRAINT free_access_registration_reservations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: free_access_registration_reservations free_access_registration_reservations_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.free_access_registration_reservations
    ADD CONSTRAINT free_access_registration_reservations_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;


--
-- Name: free_access_registration_reservations free_access_registration_reservations_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.free_access_registration_reservations
    ADD CONSTRAINT free_access_registration_reservations_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: invitation_redemptions invitation_redemptions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions
    ADD CONSTRAINT invitation_redemptions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: invitation_redemptions invitation_redemptions_invitation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions
    ADD CONSTRAINT invitation_redemptions_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES public.customer_invitations(id) ON DELETE CASCADE;


--
-- Name: invitation_redemptions invitation_redemptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions
    ADD CONSTRAINT invitation_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: jellyfin_account_lifecycle jellyfin_account_lifecycle_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_account_lifecycle
    ADD CONSTRAINT jellyfin_account_lifecycle_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: jellyfin_account_lifecycle jellyfin_account_lifecycle_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_account_lifecycle
    ADD CONSTRAINT jellyfin_account_lifecycle_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE CASCADE;


--
-- Name: jellyfin_accounts jellyfin_accounts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_accounts
    ADD CONSTRAINT jellyfin_accounts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: jellyfin_accounts jellyfin_accounts_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_accounts
    ADD CONSTRAINT jellyfin_accounts_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE RESTRICT;


--
-- Name: jellyfin_policy_drift jellyfin_policy_drift_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_policy_drift
    ADD CONSTRAINT jellyfin_policy_drift_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: jellyfin_policy_drift jellyfin_policy_drift_jellyfin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_policy_drift
    ADD CONSTRAINT jellyfin_policy_drift_jellyfin_account_id_fkey FOREIGN KEY (jellyfin_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE CASCADE;


--
-- Name: jellyfin_policy_drift jellyfin_policy_drift_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_policy_drift
    ADD CONSTRAINT jellyfin_policy_drift_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE CASCADE;


--
-- Name: jellyfin_policy_reconciliation jellyfin_policy_reconciliation_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_policy_reconciliation
    ADD CONSTRAINT jellyfin_policy_reconciliation_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: jellyfin_policy_reconciliation jellyfin_policy_reconciliation_jellyfin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_policy_reconciliation
    ADD CONSTRAINT jellyfin_policy_reconciliation_jellyfin_account_id_fkey FOREIGN KEY (jellyfin_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE CASCADE;


--
-- Name: jellyfin_server_metrics jellyfin_server_metrics_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jellyfin_server_metrics
    ADD CONSTRAINT jellyfin_server_metrics_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: payment_customers payment_customers_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: payment_incident_notes payment_incident_notes_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_incident_notes
    ADD CONSTRAINT payment_incident_notes_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: payment_incident_notes payment_incident_notes_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_incident_notes
    ADD CONSTRAINT payment_incident_notes_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.payment_incidents(id) ON DELETE CASCADE;


--
-- Name: payment_incidents payment_incidents_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_incidents
    ADD CONSTRAINT payment_incidents_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: payment_incidents payment_incidents_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_incidents
    ADD CONSTRAINT payment_incidents_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: payment_incidents payment_incidents_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_incidents
    ADD CONSTRAINT payment_incidents_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: payment_incidents payment_incidents_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_incidents
    ADD CONSTRAINT payment_incidents_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: payment_provider_credentials payment_provider_credentials_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_credentials
    ADD CONSTRAINT payment_provider_credentials_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: plan_prices plan_prices_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_prices
    ADD CONSTRAINT plan_prices_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;


--
-- Name: plan_provider_prices plan_provider_prices_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_provider_prices
    ADD CONSTRAINT plan_provider_prices_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;


--
-- Name: plan_provider_prices plan_provider_prices_plan_price_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_provider_prices
    ADD CONSTRAINT plan_provider_prices_plan_price_id_fkey FOREIGN KEY (plan_price_id) REFERENCES public.plan_prices(id) ON DELETE CASCADE;


--
-- Name: plan_provider_prices plan_provider_prices_price_plan_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_provider_prices
    ADD CONSTRAINT plan_provider_prices_price_plan_fk FOREIGN KEY (plan_price_id, plan_id) REFERENCES public.plan_prices(id, plan_id) ON DELETE CASCADE;


--
-- Name: plan_server_eligibility plan_server_eligibility_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_server_eligibility
    ADD CONSTRAINT plan_server_eligibility_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;


--
-- Name: plan_server_eligibility plan_server_eligibility_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_server_eligibility
    ADD CONSTRAINT plan_server_eligibility_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE CASCADE;


--
-- Name: plan_stremio_sources plan_stremio_sources_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_stremio_sources
    ADD CONSTRAINT plan_stremio_sources_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;


--
-- Name: plan_stremio_sources plan_stremio_sources_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_stremio_sources
    ADD CONSTRAINT plan_stremio_sources_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.stremio_sources(id) ON DELETE CASCADE;


--
-- Name: plans plans_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: platform_settings platform_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: playback_history playback_history_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history
    ADD CONSTRAINT playback_history_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: playback_history playback_history_jellyfin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history
    ADD CONSTRAINT playback_history_jellyfin_account_id_fkey FOREIGN KEY (jellyfin_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE SET NULL;


--
-- Name: playback_history playback_history_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history
    ADD CONSTRAINT playback_history_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE CASCADE;


--
-- Name: provisioning_runs provisioning_runs_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_runs
    ADD CONSTRAINT provisioning_runs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: provisioning_runs provisioning_runs_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_runs
    ADD CONSTRAINT provisioning_runs_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: referral_codes referral_codes_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: referral_redemptions referral_redemptions_referral_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_redemptions
    ADD CONSTRAINT referral_redemptions_referral_code_id_fkey FOREIGN KEY (referral_code_id) REFERENCES public.referral_codes(id) ON DELETE CASCADE;


--
-- Name: referral_redemptions referral_redemptions_referred_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_redemptions
    ADD CONSTRAINT referral_redemptions_referred_customer_id_fkey FOREIGN KEY (referred_customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: referral_reward_reversals referral_reward_reversals_payment_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_reward_reversals
    ADD CONSTRAINT referral_reward_reversals_payment_incident_id_fkey FOREIGN KEY (payment_incident_id) REFERENCES public.payment_incidents(id) ON DELETE SET NULL;


--
-- Name: referral_reward_reversals referral_reward_reversals_redemption_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_reward_reversals
    ADD CONSTRAINT referral_reward_reversals_redemption_id_fkey FOREIGN KEY (redemption_id) REFERENCES public.referral_redemptions(id) ON DELETE CASCADE;


--
-- Name: referral_reward_reversals referral_reward_reversals_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_reward_reversals
    ADD CONSTRAINT referral_reward_reversals_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: referral_service_credits referral_service_credits_applied_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_service_credits
    ADD CONSTRAINT referral_service_credits_applied_subscription_id_fkey FOREIGN KEY (applied_subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: referral_service_credits referral_service_credits_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_service_credits
    ADD CONSTRAINT referral_service_credits_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: referral_service_credits referral_service_credits_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_service_credits
    ADD CONSTRAINT referral_service_credits_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;


--
-- Name: referral_service_credits referral_service_credits_source_redemption_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_service_credits
    ADD CONSTRAINT referral_service_credits_source_redemption_id_fkey FOREIGN KEY (source_redemption_id) REFERENCES public.referral_redemptions(id) ON DELETE SET NULL;


--
-- Name: request_routes request_routes_arr_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_routes
    ADD CONSTRAINT request_routes_arr_instance_id_fkey FOREIGN KEY (arr_instance_id) REFERENCES public.arr_instances(id) ON DELETE RESTRICT;


--
-- Name: request_routes request_routes_quality_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_routes
    ADD CONSTRAINT request_routes_quality_tier_id_fkey FOREIGN KEY (quality_tier_id) REFERENCES public.request_quality_tiers(id) ON DELETE CASCADE;


--
-- Name: request_user_sync request_user_sync_applied_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_user_sync
    ADD CONSTRAINT request_user_sync_applied_plan_id_fkey FOREIGN KEY (applied_plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;


--
-- Name: request_user_sync request_user_sync_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_user_sync
    ADD CONSTRAINT request_user_sync_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: stream_policy_events stream_policy_events_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_policy_events
    ADD CONSTRAINT stream_policy_events_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: stream_policy_events stream_policy_events_jellyfin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_policy_events
    ADD CONSTRAINT stream_policy_events_jellyfin_account_id_fkey FOREIGN KEY (jellyfin_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE SET NULL;


--
-- Name: stream_policy_events stream_policy_events_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_policy_events
    ADD CONSTRAINT stream_policy_events_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE SET NULL;


--
-- Name: stremio_entitlements stremio_entitlements_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_entitlements
    ADD CONSTRAINT stremio_entitlements_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: stremio_entitlements stremio_entitlements_jellyfin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_entitlements
    ADD CONSTRAINT stremio_entitlements_jellyfin_account_id_fkey FOREIGN KEY (jellyfin_account_id) REFERENCES public.jellyfin_accounts(id) ON DELETE SET NULL;


--
-- Name: stremio_entitlements stremio_entitlements_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_entitlements
    ADD CONSTRAINT stremio_entitlements_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE SET NULL;


--
-- Name: stremio_entitlements stremio_entitlements_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_entitlements
    ADD CONSTRAINT stremio_entitlements_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE CASCADE;


--
-- Name: stremio_media_index stremio_media_index_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_media_index
    ADD CONSTRAINT stremio_media_index_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE CASCADE;


--
-- Name: stremio_media_index_state stremio_media_index_state_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_media_index_state
    ADD CONSTRAINT stremio_media_index_state_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE CASCADE;


--
-- Name: stremio_source_index_state stremio_source_index_state_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_index_state
    ADD CONSTRAINT stremio_source_index_state_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.stremio_sources(id) ON DELETE CASCADE;


--
-- Name: stremio_source_libraries stremio_source_libraries_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_libraries
    ADD CONSTRAINT stremio_source_libraries_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.stremio_sources(id) ON DELETE CASCADE;


--
-- Name: stremio_source_media_index stremio_source_media_index_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_media_index
    ADD CONSTRAINT stremio_source_media_index_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.stremio_sources(id) ON DELETE CASCADE;


--
-- Name: stremio_source_playback_leases stremio_source_playback_leases_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_playback_leases
    ADD CONSTRAINT stremio_source_playback_leases_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: stremio_source_playback_leases stremio_source_playback_leases_entitlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_playback_leases
    ADD CONSTRAINT stremio_source_playback_leases_entitlement_id_fkey FOREIGN KEY (entitlement_id) REFERENCES public.stremio_entitlements(id) ON DELETE CASCADE;


--
-- Name: stremio_source_playback_leases stremio_source_playback_leases_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_source_playback_leases
    ADD CONSTRAINT stremio_source_playback_leases_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.stremio_sources(id) ON DELETE CASCADE;


--
-- Name: stremio_sources stremio_sources_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_sources
    ADD CONSTRAINT stremio_sources_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.jellyfin_servers(id) ON DELETE SET NULL;


--
-- Name: stremio_stream_attribution stremio_stream_attribution_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_stream_attribution
    ADD CONSTRAINT stremio_stream_attribution_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: stremio_stream_attribution stremio_stream_attribution_entitlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_stream_attribution
    ADD CONSTRAINT stremio_stream_attribution_entitlement_id_fkey FOREIGN KEY (entitlement_id) REFERENCES public.stremio_entitlements(id) ON DELETE SET NULL;


--
-- Name: stremio_stream_attribution stremio_stream_attribution_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stremio_stream_attribution
    ADD CONSTRAINT stremio_stream_attribution_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.stremio_sources(id) ON DELETE SET NULL;


--
-- Name: subscription_provider_sync subscription_provider_sync_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_provider_sync
    ADD CONSTRAINT subscription_provider_sync_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE CASCADE;


--
-- Name: subscription_service_extension_events subscription_service_extension_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_service_extension_events
    ADD CONSTRAINT subscription_service_extension_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: subscription_service_extension_events subscription_service_extension_events_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_service_extension_events
    ADD CONSTRAINT subscription_service_extension_events_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: subscription_service_extension_events subscription_service_extension_events_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_service_extension_events
    ADD CONSTRAINT subscription_service_extension_events_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE RESTRICT;


--
-- Name: subscriptions subscriptions_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


