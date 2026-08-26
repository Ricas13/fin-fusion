# Customer multi-access contract

A direct customer may hold independent access to all three customer-facing lanes at the same time:

- permanent Free Server Jellyfin access;
- one Premium Jellyfin access (trial, one-time paid, or recurring paid);
- one Stremio household access (trial, one-time paid, or recurring paid).

Free Server is intentionally not superseded when Premium Jellyfin starts. It keeps a separate `jellyfin_accounts.access_lane='free'` identity and remains subject to Free-plan inactivity rules using only playback from that Free server. Premium Jellyfin uses the `primary` lane. Stremio remains independent from both Jellyfin lanes.

Overlapping duplicate paid/recurring subscriptions for the same service remain blocked. A trial may convert to paid before the trial expires.

The customer home is the canonical place to see all active access, each Jellyfin server, and the Stremio installation action. Setup and Plan & Billing are not separate customer navigation destinations.

The plan chooser exposes one shared promo-code field. The value is passed to the selected Stripe, PayPal, or Plisio checkout. PayPal recurring Billing Plans cannot safely change their configured recurring price, so a promo-carrying PayPal checkout offers the one-time PayPal option instead of silently changing an automatic-renewal contract.

Customer Help is `/account/docs`; administrator Help is `/admin/docs`.