'use strict';

const ui=require('./admin-ui');

function tabs(active='setup'){
  return ui.workflowCards([
    ['setup','Providers','/admin/payments','Stripe, PayPal, webhook readiness and provider events'],
    ['mappings','Provider mappings','/admin/provider-mappings','Map CAPTAiNFiN plans to provider products and prices'],
    ['billing','Billing','/admin/billing','Subscriptions, reconciliation and customer billing state'],
    ['reconciliation','Unmapped payments','/admin/payments/reconciliation','Provider-side payments missing a healthy local purchase record'],
    ['risk','Payment risk','/admin/payments/risk-policy','Risk, disputes and payment-access protection']
  ],active,'Payments and billing control room');
}
module.exports={tabs};
