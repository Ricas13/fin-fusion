BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.discount_redemptions ADD COLUMN IF NOT EXISTS access_extension_id uuid;
DO $extension_discount$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.discount_redemptions'::regclass AND conname='discount_redemptions_access_extension_fkey') THEN
    ALTER TABLE public.discount_redemptions ADD CONSTRAINT discount_redemptions_access_extension_fkey
      FOREIGN KEY(access_extension_id) REFERENCES public.subscription_access_extensions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.discount_redemptions'::regclass AND conname='discount_redemptions_single_purchase_check') THEN
    ALTER TABLE public.discount_redemptions ADD CONSTRAINT discount_redemptions_single_purchase_check CHECK(subscription_id IS NULL OR access_extension_id IS NULL);
  END IF;
END
$extension_discount$;
CREATE UNIQUE INDEX IF NOT EXISTS discount_redemptions_access_extension_unique ON public.discount_redemptions(access_extension_id) WHERE access_extension_id IS NOT NULL;
COMMIT;
