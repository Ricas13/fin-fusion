# Portable configuration transfer

`Settings → Setup → Configuration Transfer` exports and imports a deliberately narrow, versioned configuration document.

## Included

- Portable platform/storefront settings (site identity, storefront/public-registration switches, reconcile intervals and request-site URL)
- Storefront copy/features
- Admin/reseller defaults
- Referral-program settings
- Notification preferences
- Plan commercial/Jellyfin policy fields
- Plan library names/mode
- Plan placement strategy and server-pool bindings by **server slug**

## Always excluded

- Administrator, reseller and customer identities/passwords
- Jellyfin server URLs and API keys
- Payment credentials, payment customer IDs and provider price mappings
- Subscriptions, payment events, discount/referral redemption history
- Customer-specific policy/library selections or overrides
- Sessions, audit history, provisioning history and playback/activity data

Security policy such as mandatory administrator 2FA is not portable and is deliberately ignored by the transfer schema.

## Import safety

Imports are merge-only. They do not delete records that are absent from the document. Existing plans are updated by stable plan `code`; new codes create plans. Plan server pools are resolved by server `slug`. If any slug for a plan does not exist in the target installation, that plan's existing pool is left unchanged and the preview displays a warning rather than guessing a replacement server.

Every import must pass validation, create a server-side preview tied to the authenticated administrator/session, and then be confirmed within 15 minutes using the exact preview digest. Export/import actions are recorded in the audit log without storing the configuration document itself.
