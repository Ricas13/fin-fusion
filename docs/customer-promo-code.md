# Shared customer promo code

The customer home exposes one promo-code input for all plan payment buttons. The browser copies that value into the submitted provider form, so customers do not re-enter the same code for Stripe, PayPal or Plisio.

Server-side discount validation remains authoritative. Stripe can apply the discount to its checkout, Plisio receives the discounted one-time amount, and PayPal one-time checkout receives the discounted amount. A PayPal automatic-renewal Billing Plan is not silently repriced by a local promo code; when a promo is present, the payment-choice page disables that recurring option and directs the customer to the eligible one-time PayPal option or another provider.