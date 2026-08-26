BEGIN;

-- Keep the permanent Free Server identity separate from a Premium/trial
-- Jellyfin identity. A customer can therefore keep using Free while trying or
-- buying Premium, and the Free identity can age out independently later.
ALTER TABLE public.jellyfin_accounts
    ADD COLUMN IF NOT EXISTS access_lane text;

UPDATE public.jellyfin_accounts
SET access_lane='primary'
WHERE access_lane IS NULL;

ALTER TABLE public.jellyfin_accounts
    ALTER COLUMN access_lane SET DEFAULT 'primary',
    ALTER COLUMN access_lane SET NOT NULL;

DO $$
BEGIN
    ALTER TABLE public.jellyfin_accounts
        ADD CONSTRAINT jellyfin_accounts_access_lane_check
        CHECK (access_lane IN ('primary','free'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Existing Free-only customers already have a normal Jellyfin identity. Adopt
-- it into the Free lane rather than creating a duplicate after deployment.
UPDATE public.jellyfin_accounts ja
SET access_lane='free'
WHERE ja.account_purpose='jellyfin'
  AND EXISTS (
      SELECT 1
      FROM public.subscriptions s
      JOIN public.plans p ON p.id=s.plan_id
      WHERE s.customer_id=ja.customer_id
        AND p.is_free_tier=TRUE
        AND COALESCE(p.is_addon,FALSE)=FALSE
        AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
        AND s.superseded_by IS NULL
        AND s.starts_at<=NOW()
        AND s.status IN ('active','trialing','past_due','paused')
        AND s.current_period_end>NOW()
  )
  AND (
      ja.is_primary=FALSE
      OR NOT EXISTS (
          SELECT 1
          FROM public.subscriptions s2
          JOIN public.plans p2 ON p2.id=s2.plan_id
          WHERE s2.customer_id=ja.customer_id
            AND COALESCE(p2.is_addon,FALSE)=FALSE
            AND COALESCE(p2.is_free_tier,FALSE)=FALSE
            AND COALESCE(NULLIF(s2.service_type_snapshot,''),p2.service_type,'jellyfin') IN ('jellyfin','bundle')
            AND s2.superseded_by IS NULL
            AND s2.starts_at<=NOW()
            AND s2.status IN ('active','trialing','past_due','paused')
            AND s2.current_period_end>NOW()
      )
  );

CREATE INDEX IF NOT EXISTS jellyfin_accounts_customer_access_lane_idx
    ON public.jellyfin_accounts(customer_id,access_lane,disabled)
    WHERE account_purpose='jellyfin';

-- Payment delinquency remains tied to one provider subscription. Free Server
-- inactivity/cleanup holds are deliberately Free-only so they cannot suspend a
-- simultaneous Premium Jellyfin or Stremio subscription. Administrative and
-- safety holds remain customer-wide.
CREATE OR REPLACE FUNCTION public.subscription_access_blocked(
    p_customer_id uuid,
    p_source text,
    p_provider_subscription_id text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.customer_access_holds h
        WHERE h.customer_id=p_customer_id
          AND h.released_at IS NULL
          AND (
              (h.hold_type='payment_delinquency' AND h.source_key = CASE
                  WHEN p_source='stripe' AND COALESCE(p_provider_subscription_id,'') LIKE 'sub\_%' ESCAPE '\' THEN 'stripe:' || p_provider_subscription_id
                  WHEN p_source='paypal' AND COALESCE(p_provider_subscription_id,'') LIKE 'I-%' THEN 'paypal:' || p_provider_subscription_id
                  ELSE NULL
              END)
              OR (h.hold_type IN ('inactivity_policy','jellyfin_cleanup') AND p_source='free_claim')
              OR h.hold_type NOT IN ('payment_delinquency','inactivity_policy','jellyfin_cleanup')
          )
    );
$$;

COMMIT;
