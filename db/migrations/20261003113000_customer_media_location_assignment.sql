-- Customer-selectable media location/server assignment.
-- All columns are nullable so the previous application generation can continue
-- serving during a rolling deployment. Existing customers are deliberately not
-- backfilled or moved; the reconciler adopts their current server assignment
-- when it next sees a matching account.

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
