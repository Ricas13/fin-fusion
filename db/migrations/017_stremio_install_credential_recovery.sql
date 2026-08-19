CREATE TABLE public.stremio_install_credential_recovery (
    customer_id uuid PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
    entitlement_id uuid NOT NULL REFERENCES public.stremio_entitlements(id) ON DELETE CASCADE,
    token_version integer NOT NULL,
    token_hint text,
    credential_encrypted text NOT NULL,
    issued_by_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX stremio_install_credential_recovery_entitlement_idx
    ON public.stremio_install_credential_recovery(entitlement_id);
