BEGIN;

INSERT INTO automation_job_state(job_key,interval_seconds)
VALUES ('plan_changes',300)
ON CONFLICT(job_key) DO NOTHING;

INSERT INTO platform_settings(setting_key,setting_value)
VALUES ('commerce_policy',jsonb_build_object(
    'stripeUpgradeTiming','immediate',
    'stripeDowngradeTiming','period_end',
    'paypalPlanChanges','new_authorization_at_period_end'
)) ON CONFLICT(setting_key) DO NOTHING;

INSERT INTO notification_preferences(event_type) VALUES
 ('customer.plan_change.scheduled'),
 ('customer.plan_change.applied'),
 ('customer.plan_change.failed'),
 ('customer.subscription.cancelled'),
 ('payment.refunded'),
 ('payment.disputed')
ON CONFLICT(event_type) DO NOTHING;

COMMIT;
