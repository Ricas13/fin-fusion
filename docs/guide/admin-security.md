# Security and access

CAPTAiNFiN separates portal identity, Jellyfin credentials and infrastructure secrets.

## Administrator and reseller sign-in

Two-factor authentication is optional unless the corresponding enforcement policy is enabled. When enforcement is enabled, users who have not enrolled are directed through setup at sign-in.

## Customer portal password vs Jellyfin password

The customer portal password and Jellyfin password are separate credentials. Resetting the portal password does not change the Jellyfin password.

Newly provisioned Jellyfin accounts can require an explicit Jellyfin password setup rather than reusing the portal password.

## Recovery codes

Treat recovery codes like passwords. Store them somewhere secure and do not paste them into support tickets or public chat.

## API keys and provider credentials

Jellyfin API keys, payment-provider secrets, request-service API keys and SMTP passwords are infrastructure credentials. CAPTAiNFiN stores supported browser-managed secrets encrypted at rest and does not intentionally display decrypted secrets back to administrators after storage.

## Invite and claim links

Invitation and customer-claim links use bearer tokens. Anyone holding a valid unused link may be able to redeem it, so share it only with the intended person. CAPTAiNFiN stores supported claim/invitation tokens as hashes rather than retaining the raw bearer value for later display.

## Canonical public URL

Production should have a canonical HTTPS public origin. This is used to build external links safely and prevents the application from trusting arbitrary request Host values for generated customer links.

## Audit records

Security-sensitive administrator and authentication events are written to append-only audit records. Do not use database cleanup as a substitute for lifecycle actions.
