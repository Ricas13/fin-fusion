-- Shadow-only duration accounting. Existing playback history and Free
-- inactivity decisions are unchanged until comparison tests establish parity.
ALTER TABLE public.playback_history
  ADD COLUMN IF NOT EXISTS observed_watch_seconds double precision,
  ADD COLUMN IF NOT EXISTS observed_confirmed_seconds double precision,
  ADD COLUMN IF NOT EXISTS observed_anchor_at timestamptz,
  ADD COLUMN IF NOT EXISTS observed_last_at timestamptz,
  ADD COLUMN IF NOT EXISTS observed_last_position_ticks double precision,
  ADD COLUMN IF NOT EXISTS observed_last_paused boolean,
  ADD COLUMN IF NOT EXISTS observed_sample_count integer,
  ADD COLUMN IF NOT EXISTS observed_last_source text,
  ADD COLUMN IF NOT EXISTS observed_ended boolean;
