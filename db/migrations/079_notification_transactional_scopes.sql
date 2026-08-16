BEGIN;

-- These events are transactional acknowledgements used by existing customer
-- flows. They remain eligible for the mandatory email safety path, while not
-- being offered as optional customer notification toggles. Administrators may
-- still opt into them independently.
INSERT INTO notification_preferences(event_type,event_scope,customer_opt_in_allowed,display_name,description)
VALUES
 ('customer.subscription.requested','both',FALSE,'Subscription request received','A customer submitted a subscription request.'),
 ('customer.trial.requested','both',FALSE,'Trial request received','A customer submitted a trial request.'),
 ('customer.stremio.requested','both',FALSE,'Stremio request received','A customer submitted a Stremio access request.'),
 ('customer.reseller.requested','both',FALSE,'Reseller request received','A customer submitted a reseller access request.')
ON CONFLICT(event_type) DO UPDATE SET
 event_scope=EXCLUDED.event_scope,
 customer_opt_in_allowed=FALSE,
 display_name=COALESCE(notification_preferences.display_name,EXCLUDED.display_name),
 description=COALESCE(notification_preferences.description,EXCLUDED.description);

COMMIT;
