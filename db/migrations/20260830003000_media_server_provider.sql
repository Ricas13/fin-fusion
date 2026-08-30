ALTER TABLE public.jellyfin_servers
  ADD COLUMN IF NOT EXISTS media_server_type TEXT NOT NULL DEFAULT 'jellyfin';

ALTER TABLE public.jellyfin_servers
  DROP CONSTRAINT IF EXISTS jellyfin_servers_media_server_type_check;

ALTER TABLE public.jellyfin_servers
  ADD CONSTRAINT jellyfin_servers_media_server_type_check
  CHECK (media_server_type IN ('jellyfin','emby'));

COMMENT ON COLUMN public.jellyfin_servers.media_server_type IS
  'MediaBrowser-compatible server implementation. Existing rows remain jellyfin; emby is supported through the media-server adapter boundary.';
