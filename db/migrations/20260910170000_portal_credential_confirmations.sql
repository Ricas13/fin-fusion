BEGIN;

ALTER TABLE account_tokens
    DROP CONSTRAINT IF EXISTS account_tokens_token_type_check;

ALTER TABLE account_tokens
    ADD CONSTRAINT account_tokens_token_type_check
    CHECK (token_type = ANY (ARRAY[
        'email_verify'::text,
        'password_reset'::text,
        'email_change'::text,
        'portal_password_change'::text,
        'portal_email_old_approval'::text,
        'portal_email_new_verification'::text
    ]));

CREATE INDEX IF NOT EXISTS account_tokens_user_type_live_idx
    ON account_tokens(user_id,token_type,expires_at)
    WHERE consumed_at IS NULL;

COMMIT;
