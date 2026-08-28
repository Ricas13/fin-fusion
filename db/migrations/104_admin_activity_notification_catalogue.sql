BEGIN;

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
    ('customer.claimed', FALSE, FALSE, FALSE, FALSE, 'admin', FALSE, 'Customer claimed imported account', 'An imported Jellyfin customer completed creation of their portal identity.'),
    ('commercial.discount.redeemed', FALSE, FALSE, FALSE, FALSE, 'admin', FALSE, 'Discount redeemed', 'A customer completed a purchase using a discount code.'),
    ('customer.access.suspended', FALSE, FALSE, FALSE, FALSE, 'admin', FALSE, 'Customer access suspended', 'A durable access hold was added to a customer, including its reason and provider state when available.'),
    ('login.customer.succeeded', FALSE, FALSE, FALSE, FALSE, 'admin', FALSE, 'Customer signed in', 'A customer completed portal sign-in. This is a high-volume activity event and is off by default.')
ON CONFLICT(event_type) DO UPDATE SET
    event_scope=EXCLUDED.event_scope,
    customer_opt_in_allowed=EXCLUDED.customer_opt_in_allowed,
    display_name=EXCLUDED.display_name,
    description=EXCLUDED.description,
    updated_at=NOW();

COMMIT;
