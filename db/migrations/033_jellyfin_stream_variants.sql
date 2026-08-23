-- Optional paid Jellyfin stream-count variants.
-- The logical CAPTAiNFiN plan remains one catalogue product. Each extra stream
-- count has its own local amount and provider mapping so recurring contracts can
-- be snapshotted/grandfathered without modelling streams as subscription add-ons.

CREATE TABLE IF NOT EXISTS plan_stream_variants (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  streams integer NOT NULL CHECK (streams >= 1 AND streams <= 50),
  currency character(3) NOT NULL,
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  active boolean NOT NULL DEFAULT TRUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(plan_id, streams, currency)
);

CREATE INDEX IF NOT EXISTS idx_plan_stream_variants_plan_active
  ON plan_stream_variants(plan_id, active, currency, streams);

CREATE TABLE IF NOT EXISTS plan_stream_variant_provider_prices (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  stream_variant_id uuid NOT NULL REFERENCES plan_stream_variants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe','paypal')),
  checkout_mode text NOT NULL CHECK (checkout_mode IN ('payment','subscription')),
  external_id text,
  active boolean NOT NULL DEFAULT TRUE,
  verified_at timestamp with time zone,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','drift','error','not_required')),
  verification_error text,
  remote_amount_minor integer,
  remote_currency character(3),
  remote_interval text,
  remote_active boolean,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(stream_variant_id, provider, checkout_mode)
);

CREATE INDEX IF NOT EXISTS idx_stream_variant_provider_lookup
  ON plan_stream_variant_provider_prices(provider, external_id)
  WHERE active=TRUE AND external_id IS NOT NULL;
