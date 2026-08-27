BEGIN;

CREATE TABLE IF NOT EXISTS customer_lane_policy_overrides (
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    access_lane text NOT NULL,
    streams integer,
    allow_downloads boolean,
    allow_video_transcoding boolean,
    allow_audio_transcoding boolean,
    allow_remuxing boolean,
    allow_live_tv boolean,
    allow_live_tv_management boolean,
    allow_remote_access boolean,
    updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, access_lane),
    CONSTRAINT customer_lane_policy_overrides_lane_check CHECK (access_lane IN ('primary','free')),
    CONSTRAINT customer_lane_policy_overrides_streams_check CHECK (streams IS NULL OR (streams >= 1 AND streams <= 50))
);

COMMENT ON TABLE customer_lane_policy_overrides IS 'Per-customer Jellyfin technical overrides scoped to a concrete access lane. Legacy customer_policy_overrides remain a primary-lane fallback only.';

-- Existing global overrides historically described the one/main Jellyfin identity.
-- Migrate them to primary only; never copy them to Free Access.
INSERT INTO customer_lane_policy_overrides(
    customer_id,access_lane,streams,allow_downloads,allow_video_transcoding,
    allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,
    allow_remote_access,updated_by,updated_at
)
SELECT customer_id,'primary',streams,allow_downloads,allow_video_transcoding,
       allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,
       allow_remote_access,updated_by,updated_at
FROM customer_policy_overrides
ON CONFLICT (customer_id,access_lane) DO NOTHING;

-- Historically the schema defaulted audio transcoding and Live TV to enabled.
-- New Jellyfin plans should be conservative unless the operator deliberately
-- grants those capabilities.
ALTER TABLE plans ALTER COLUMN allow_audio_transcoding SET DEFAULT FALSE;
ALTER TABLE plans ALTER COLUMN allow_live_tv SET DEFAULT FALSE;

-- Bring the direct Jellyfin catalogue back to the intended product contract:
-- Free and Trial do not download; paid recurring access does. Live TV and all
-- server-side media conversion are opt-in rather than silently inherited from
-- the old permissive defaults. Existing stream counts are preserved except for
-- Free Access, which is canonically one concurrent stream.
UPDATE plans
SET streams=CASE WHEN is_free_tier=TRUE THEN 1 ELSE streams END,
    allow_downloads=CASE
        WHEN is_free_tier=TRUE OR billing_interval='trial' THEN FALSE
        WHEN price_minor>0 THEN TRUE
        ELSE allow_downloads
    END,
    allow_video_transcoding=FALSE,
    allow_audio_transcoding=FALSE,
    allow_remuxing=FALSE,
    allow_live_tv=FALSE,
    allow_live_tv_management=FALSE,
    allow_remote_access=TRUE,
    updated_at=NOW()
WHERE COALESCE(is_addon,FALSE)=FALSE
  AND service_type='jellyfin'
  AND audience IN ('direct','both');

-- Imported portal users are allowed to exist without an email. There is no
-- mailbox to verify in that state, so the verification gate is satisfied for
-- email-less customer identities while normal public registration still
-- requires a real email address. Adding/changing an email later follows the
-- normal staged email-verification workflow.
UPDATE app_users
SET email_verified_at=COALESCE(email_verified_at,NOW()),updated_at=NOW()
WHERE role='customer' AND email IS NULL;

CREATE OR REPLACE FUNCTION public.customer_no_email_verification_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role='customer' AND NEW.email IS NULL AND NEW.email_verified_at IS NULL THEN
        NEW.email_verified_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_no_email_verification_state ON app_users;
CREATE TRIGGER trg_customer_no_email_verification_state
BEFORE INSERT OR UPDATE OF email,email_verified_at ON app_users
FOR EACH ROW EXECUTE FUNCTION public.customer_no_email_verification_state();

COMMIT;
