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

-- Imported portal users are allowed to exist without an email. They have no
-- email address to verify, so treat that state as verification-complete while
-- keeping normal email registration/verification unchanged.
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
