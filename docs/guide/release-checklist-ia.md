# IA release verification checklist

Before merging this release:

- run the fast/static checks including the retired-invitations and customer-portal IA smoke tests;
- run database lifecycle/coherence checks;
- run admin browser regression and customer portal/browser payment flows;
- verify a clean install and an upgrade from the previous release;
- confirm the exact PR head has no failing GitHub Actions workflows;
- confirm `/invite/...` fails closed and `/admin/invitations` is not a live workflow;
- confirm Free Access remains visible at zero availability;
- confirm reseller storefront pricing follows the selected enabled currency;
- confirm Customer 360 exposes Jellyfin password support without a permanent sidebar destination;
- confirm customer checkout copy explains plan-change timing before submission.
