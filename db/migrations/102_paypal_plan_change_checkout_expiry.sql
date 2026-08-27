BEGIN;

ALTER TABLE customer_plan_changes DROP CONSTRAINT customer_plan_changes_state_check;
ALTER TABLE customer_plan_changes ADD CONSTRAINT customer_plan_changes_state_check
    CHECK (state = ANY (ARRAY['pending'::text, 'applied'::text, 'cancelled'::text, 'failed'::text, 'awaiting_checkout'::text]));

INSERT INTO notification_preferences(
    event_type,
    telegram_enabled,
    email_enabled,
    discord_enabled,
    whatsapp_enabled,
    event_scope,
    customer_opt_in_allowed,
    display_name,
    description
) VALUES
    ('subscription.plan_change.requires_checkout', TRUE, TRUE, TRUE, TRUE, 'both', TRUE, 'PayPal plan change needs a new checkout', 'A customer''s recorded PayPal plan change reached its effective date; their prior PayPal renewal has ended and they must complete a fresh checkout to move onto the new plan.')
ON CONFLICT(event_type) DO UPDATE SET
    event_scope=EXCLUDED.event_scope,
    customer_opt_in_allowed=EXCLUDED.customer_opt_in_allowed,
    display_name=EXCLUDED.display_name,
    description=EXCLUDED.description;

COMMIT;
