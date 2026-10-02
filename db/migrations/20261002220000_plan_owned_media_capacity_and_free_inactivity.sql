BEGIN;

-- Separate infrastructure capacity from product allocation policy.
--
-- jellyfin_servers.max_users remains the physical managed-customer ceiling for
-- each Jellyfin/Emby server. plans.media_user_limit is an optional product-level
-- ceiling for media-server plans and is deliberately NULL on upgrade so an
-- old, previously-ignored plans.capacity_limit value cannot unexpectedly close
-- an existing Jellyfin product.
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS media_user_limit integer,
  ADD COLUMN IF NOT EXISTS free_first_playback_grace_days integer,
  ADD COLUMN IF NOT EXISTS free_playback_window_days integer,
  ADD COLUMN IF NOT EXISTS free_minimum_playback_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='plans_media_user_limit_check'
      AND conrelid='plans'::regclass
  ) THEN
    ALTER TABLE plans
      ADD CONSTRAINT plans_media_user_limit_check
      CHECK (media_user_limit IS NULL OR media_user_limit BETWEEN 0 AND 1000000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='plans_free_first_playback_grace_days_check'
      AND conrelid='plans'::regclass
  ) THEN
    ALTER TABLE plans
      ADD CONSTRAINT plans_free_first_playback_grace_days_check
      CHECK (free_first_playback_grace_days IS NULL OR free_first_playback_grace_days BETWEEN 1 AND 3650);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='plans_free_playback_window_days_check'
      AND conrelid='plans'::regclass
  ) THEN
    ALTER TABLE plans
      ADD CONSTRAINT plans_free_playback_window_days_check
      CHECK (free_playback_window_days IS NULL OR free_playback_window_days BETWEEN 1 AND 365);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='plans_free_minimum_playback_minutes_check'
      AND conrelid='plans'::regclass
  ) THEN
    ALTER TABLE plans
      ADD CONSTRAINT plans_free_minimum_playback_minutes_check
      CHECK (free_minimum_playback_minutes IS NULL OR free_minimum_playback_minutes BETWEEN 1 AND 1000000);
  END IF;
END
$$;

-- Safely lift the historical per-server inactivity thresholds onto a Free plan
-- only when every currently matching Jellyfin server agrees on the same policy.
-- If servers disagree, leave the plan values NULL and the runtime continues to
-- use the legacy per-server values until the administrator explicitly saves the
-- policy on the Free plan. This prevents a deployment from changing cleanup
-- behaviour for any existing Free account.
WITH free_plan_policy AS (
  SELECT
    p.id AS plan_id,
    MIN(js.free_first_playback_grace_days) AS first_grace_min,
    MAX(js.free_first_playback_grace_days) AS first_grace_max,
    MIN(js.free_playback_window_days) AS window_min,
    MAX(js.free_playback_window_days) AS window_max,
    MIN(js.free_minimum_playback_minutes) AS minutes_min,
    MAX(js.free_minimum_playback_minutes) AS minutes_max,
    COUNT(js.id) AS server_count
  FROM plans p
  LEFT JOIN jellyfin_servers js
    ON js.server_class=p.server_class
   AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
  WHERE p.is_free_tier=TRUE
    AND COALESCE(p.service_type,'jellyfin') IN ('jellyfin','bundle')
  GROUP BY p.id
)
UPDATE plans p
SET
  free_first_playback_grace_days=CASE
    WHEN f.server_count>0 AND f.first_grace_min=f.first_grace_max THEN f.first_grace_min
    ELSE p.free_first_playback_grace_days
  END,
  free_playback_window_days=CASE
    WHEN f.server_count>0 AND f.window_min=f.window_max THEN f.window_min
    ELSE p.free_playback_window_days
  END,
  free_minimum_playback_minutes=CASE
    WHEN f.server_count>0 AND f.minutes_min=f.minutes_max THEN f.minutes_min
    ELSE p.free_minimum_playback_minutes
  END,
  updated_at=NOW()
FROM free_plan_policy f
WHERE p.id=f.plan_id;

COMMENT ON COLUMN plans.media_user_limit IS
'Optional product-level managed-customer ceiling for Jellyfin/Emby delivery. Physical server capacity remains jellyfin_servers.max_users.';

COMMENT ON COLUMN plans.free_first_playback_grace_days IS
'Free-plan inactivity policy. NULL preserves the legacy assigned-server policy until explicitly configured on the plan.';
COMMENT ON COLUMN plans.free_playback_window_days IS
'Free-plan rolling playback window. NULL preserves the legacy assigned-server policy until explicitly configured on the plan.';
COMMENT ON COLUMN plans.free_minimum_playback_minutes IS
'Free-plan minimum playback requirement. NULL preserves the legacy assigned-server policy until explicitly configured on the plan.';

COMMIT;
