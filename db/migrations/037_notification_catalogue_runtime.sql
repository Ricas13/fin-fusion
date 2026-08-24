BEGIN;

-- These controls represented retired, duplicate, or purely derived workflows.
-- Remove per-user selections first because event_type is intentionally not a
-- foreign key to the catalogue table.
DELETE FROM admin_notification_preferences
WHERE event_type IN (
    'account.announcement',
    'attention.created',
    'customer.created',
    'request.created',
    'security.alert',
    'customer.subscription.cancelled',
    'customer.subscription.requested',
    'customer.trial.requested',
    'customer.stremio.requested'
);

DELETE FROM customer_notification_preferences
WHERE event_type IN (
    'account.announcement',
    'attention.created',
    'customer.created',
    'request.created',
    'security.alert',
    'customer.subscription.cancelled',
    'customer.subscription.requested',
    'customer.trial.requested',
    'customer.stremio.requested'
);

DELETE FROM notification_preferences
WHERE event_type IN (
    'account.announcement',
    'attention.created',
    'customer.created',
    'request.created',
    'security.alert',
    'customer.subscription.cancelled',
    'customer.subscription.requested',
    'customer.trial.requested',
    'customer.stremio.requested'
);

-- A failed renewal has two distinct audiences: the customer gets the required
-- billing-action message, while operators use payment.renewal_failed. Keeping
-- payment.failed customer-scoped avoids duplicate admin alerts.
UPDATE notification_preferences
SET event_scope='customer',
    customer_opt_in_allowed=TRUE,
    display_name='Payment failed',
    description='A customer payment or renewal failed and the customer needs to review billing.',
    updated_at=NOW()
WHERE event_type='payment.failed';

COMMIT;
