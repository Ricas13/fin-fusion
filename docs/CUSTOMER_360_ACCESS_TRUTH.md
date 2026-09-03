# Customer 360 access truth

Customer 360 separates **commercial truth** from **observed service state**.

The Overview page first shows the customer's current entitlement and active access holds. Directly below that, **Service reconciliation truth** projects the last canonical reconciliation result into one row per service/lane:

- Jellyfin primary;
- Jellyfin Free;
- Emby;
- Stremio;
- Discord role synchronization.

Each row shows the desired state, the last observed state, the associated plan, account/server reference when available, any blocker/error, and the reconciliation timestamp.

The row renderer does not issue entitlement queries or reimplement reconciliation rules. It consumes the subscriptions/accounts already loaded for Customer 360 plus `customer_provisioning_state.last_result`, which is written by the canonical multi-service reconciler.

## Unknown is not healthy

If a service has no persisted reconciliation result, Customer 360 displays **No reconciliation snapshot**. It must not infer that missing observed state means healthy or converged.

Likewise, commercial entitlement remains visible when access is blocked. A hold is an access blocker, not a replacement for subscription truth.

## Support interpretation

A healthy case should normally read as desired **Enabled** and observed **Active/Enabled** for entitled services. Useful mismatch examples include:

- desired Enabled / observed Inactive;
- desired Enabled / no reconciliation snapshot;
- desired Blocked by access hold / observed Blocked;
- no required service / an unexpectedly enabled account.

When a mismatch exists, operators should use the existing **Access** tab and reconciliation controls rather than editing database state directly.
