ALTER TABLE public.stremio_sources
  ADD COLUMN IF NOT EXISTS media_server_type TEXT NOT NULL DEFAULT 'jellyfin';

ALTER TABLE public.stremio_sources
  DROP CONSTRAINT IF EXISTS stremio_sources_media_server_type_check;

ALTER TABLE public.stremio_sources
  ADD CONSTRAINT stremio_sources_media_server_type_check
  CHECK (media_server_type IN ('jellyfin','emby'));

COMMENT ON COLUMN public.stremio_sources.media_server_type IS
  'External MediaBrowser source provider. Existing sources remain jellyfin; emby sources use the shared media-server adapter.';
