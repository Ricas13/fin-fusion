-- Whether a client ever reported playback progress (position movement or a stop) for a play.
-- NULL = history recorded before this was tracked. FALSE = only the start was ever observed, so the
-- duration is an estimate from how long Jellyfin listed the session, not a measured watch time.
ALTER TABLE public.playback_history
    ADD COLUMN IF NOT EXISTS progress_reported boolean;
