ALTER TABLE public.stremio_entitlements
  ADD COLUMN IF NOT EXISTS token_hash_aliases text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS stremio_entitlements_token_hash_aliases_gin
  ON public.stremio_entitlements USING gin (token_hash_aliases);

COMMENT ON COLUMN public.stremio_entitlements.token_hash_aliases IS
  'Historical SHA-256 install-token hashes preserved only when automatic portal recovery must replace an unrecoverable token without breaking an already-installed addon. Explicit rotation/revoke does not preserve them.';
