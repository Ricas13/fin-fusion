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
    ('support.ticket.needs_staff', TRUE, TRUE, TRUE, TRUE, 'admin', FALSE, 'Support ticket needs staff', 'A customer opened a support ticket or replied to one that now needs staff attention.'),
    ('support.ticket.staff_reply', TRUE, TRUE, TRUE, TRUE, 'customer', TRUE, 'Support ticket updates', 'A staff member replied to one of the customer''s support tickets.')
ON CONFLICT(event_type) DO UPDATE SET
    event_scope=EXCLUDED.event_scope,
    customer_opt_in_allowed=EXCLUDED.customer_opt_in_allowed,
    display_name=EXCLUDED.display_name,
    description=EXCLUDED.description;

COMMIT;
