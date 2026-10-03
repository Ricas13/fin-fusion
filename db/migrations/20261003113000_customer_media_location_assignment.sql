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
  ADD COLUMN IF NOT EXISTS media_location varchar(100),
  ADD COLUMN IF NOT EXISTS media_server_id uuid;

ALTER TABLE billing_checkout_intents
  ADD COLUMN IF NOT EXISTS media_server_id uuid;

ALTER TABLE customer_plan_changes
  ADD COLUMN IF NOT EXISTS target_media_location varchar(100),
  ADD COLUMN IF NOT EXISTS target_media_server_id uuid;

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

DO $media_assignment$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='free_access_registration_reservations_media_server_id_fkey'
      AND conrelid='free_access_registration_reservations'::regclass
  ) THEN
    ALTER TABLE free_access_registration_reservations
      ADD CONSTRAINT free_access_registration_reservations_media_server_id_fkey
      FOREIGN KEY (media_server_id)
      REFERENCES jellyfin_servers(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='billing_checkout_intents_media_server_id_fkey'
      AND conrelid='billing_checkout_intents'::regclass
  ) THEN
    ALTER TABLE billing_checkout_intents
      ADD CONSTRAINT billing_checkout_intents_media_server_id_fkey
      FOREIGN KEY (media_server_id)
      REFERENCES jellyfin_servers(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='customer_plan_changes_target_media_server_id_fkey'
      AND conrelid='customer_plan_changes'::regclass
  ) THEN
    ALTER TABLE customer_plan_changes
      ADD CONSTRAINT customer_plan_changes_target_media_server_id_fkey
      FOREIGN KEY (target_media_server_id)
      REFERENCES jellyfin_servers(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END
$media_assignment$;

ALTER TABLE subscriptions
  VALIDATE CONSTRAINT subscriptions_media_server_id_fkey;
ALTER TABLE free_access_registration_reservations
  VALIDATE CONSTRAINT free_access_registration_reservations_media_server_id_fkey;
ALTER TABLE billing_checkout_intents
  VALIDATE CONSTRAINT billing_checkout_intents_media_server_id_fkey;
ALTER TABLE customer_plan_changes
  VALIDATE CONSTRAINT customer_plan_changes_target_media_server_id_fkey;

CREATE INDEX IF NOT EXISTS subscriptions_media_server_id_idx
  ON subscriptions(media_server_id)
  WHERE media_server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS free_access_registration_reservations_media_server_id_idx
  ON free_access_registration_reservations(media_server_id)
  WHERE media_server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_checkout_intents_media_server_id_idx
  ON billing_checkout_intents(media_server_id)
  WHERE media_server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_plan_changes_target_media_server_id_idx
  ON customer_plan_changes(target_media_server_id)
  WHERE target_media_server_id IS NOT NULL;

WITH matching_assignments AS (
  SELECT s.id AS subscription_id,
         ja.server_id,
         NULLIF(BTRIM(js.location),'') AS location,
         COUNT(*) OVER (PARTITION BY s.id) AS matching_account_count,
         ROW_NUMBER() OVER (
           PARTITION BY s.id
           ORDER BY ja.disabled ASC,ja.is_primary DESC,ja.created_at ASC,ja.id ASC
         ) AS matching_account_rank
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
),
current_assignments AS (
  SELECT subscription_id,server_id,location
  FROM matching_assignments
  WHERE matching_account_count=1
    AND matching_account_rank=1
)
UPDATE subscriptions s
SET media_server_id=a.server_id,
    media_location_snapshot=COALESCE(a.location,'Default'),
    media_location_preference=COALESCE(NULLIF(s.media_location_preference,''),COALESCE(a.location,'Default')),
    updated_at=NOW()
FROM current_assignments a
WHERE s.id=a.subscription_id
  AND s.media_server_id IS NULL;
