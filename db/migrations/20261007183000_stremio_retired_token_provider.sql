ALTER TABLE public.stremio_source_retired_tokens
  ADD COLUMN IF NOT EXISTS media_server_type text NOT NULL DEFAULT 'jellyfin';

UPDATE public.stremio_source_retired_tokens r
SET media_server_type=s.media_server_type
FROM public.stremio_sources s
WHERE s.id=r.source_id
  AND r.media_server_type IS DISTINCT FROM s.media_server_type;

ALTER TABLE public.stremio_source_retired_tokens
  DROP CONSTRAINT IF EXISTS stremio_source_retired_tokens_media_server_type_check;

ALTER TABLE public.stremio_source_retired_tokens
  ADD CONSTRAINT stremio_source_retired_tokens_media_server_type_check
  CHECK (media_server_type IN ('jellyfin','emby'));

COMMENT ON COLUMN public.stremio_source_retired_tokens.media_server_type IS
  'Provider identity retained with the retired token so logout remains correct even after the source is changed or deleted.';
