-- Customer-selectable media location/server assignment.
-- All columns are nullable so the previous application generation can continue
-- serving during a rolling deployment. Existing customers are never moved by
-- this migration; their current live media-account server is recorded as the
-- initial sticky assignment where it can be identified unambiguously.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS media_location_preference varchar(100),
  ADD COLUMN IF NOT EXISTS media_server_id uuid,
  ADD COLUMN IF NOT EXISTS media_location_snapshot varchar(100);

ALTER TABLE free_access_registration_reservations
  ADD COLUMN IF NOT EXISTS media_location varchar(100);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='subscriptions_media_server_id_fkey'
      AND conrelid='subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_media_server_id_fkey
      FOREIGN KEY (media_server_id)
      REFERENCES jellyfin_servers(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE subscriptions
  VALIDATE CONSTRAINT subscriptions_media_server_id_fkey;

CREATE INDEX IF NOT EXISTS subscriptions_media_server_id_idx
  ON subscriptions(media_server_id)
  WHERE media_server_id IS NOT NULL;

WITH current_assignments AS (
  SELECT DISTINCT ON (s.id)
         s.id AS subscription_id,
         ja.server_id,
         NULLIF(BTRIM(js.location),'') AS location
  FROM subscriptions s
  JOIN plans p ON p.id=s.plan_id
  JOIN jellyfin_accounts ja
    ON ja.customer_id=s.customer_id
   AND ja.account_purpose='jellyfin'
  JOIN jellyfin_servers js ON js.id=ja.server_id
  WHERE s.media_server_id IS NULL
    AND s.superseded_by IS NULL
    AND (
      (
        p.service_type='emby'
        AND COALESCE(js.media_server_type,'jellyfin')='emby'
      )
      OR (
        p.service_type IN('jellyfin','bundle')
        AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
        AND (
          (COALESCE(p.is_free_tier,FALSE)=TRUE AND COALESCE(ja.access_lane,'primary')='free')
          OR
          (COALESCE(p.is_free_tier,FALSE)=FALSE AND COALESCE(ja.access_lane,'primary')='primary')
        )
      )
    )
  ORDER BY s.id,ja.disabled ASC,ja.is_primary DESC,ja.created_at ASC
)
UPDATE subscriptions s
SET media_server_id=a.server_id,
    media_location_snapshot=COALESCE(a.location,'Default'),
    media_location_preference=COALESCE(NULLIF(s.media_location_preference,''),COALESCE(a.location,'Default')),
    updated_at=NOW()
FROM current_assignments a
WHERE s.id=a.subscription_id
  AND s.media_server_id IS NULL;
