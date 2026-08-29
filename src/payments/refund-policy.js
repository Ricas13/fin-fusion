'use strict';

function nonNegativeMinor(value,label){
    const amount=Number(value);
    if(!Number.isSafeInteger(amount)||amount<0)throw new Error(`${label} must be a non-negative integer amount.`);
    return amount;
}

function providerCashPaidMinor(snapshot={}){
    const explicit=snapshot.providerPaidMinor??snapshot.cashPaidMinor;
    if(explicit!=null)return nonNegativeMinor(explicit,'Provider-paid amount');
    if(snapshot.discountedMinor!=null)return nonNegativeMinor(snapshot.discountedMinor,'Provider-paid amount');
    if(snapshot.priceMinor!=null&&!snapshot.serviceCreditMinor)return nonNegativeMinor(snapshot.priceMinor,'Provider-paid amount');
    throw new Error('Provider-paid amount is unavailable; cash refund cannot be calculated safely.');
}

function remainingProviderRefundableMinor({providerPaidMinor:paid,refundedMinor=0}){
    const providerPaid=nonNegativeMinor(paid,'Provider-paid amount');
    const refunded=nonNegativeMinor(refundedMinor,'Already-refunded amount');
    if(refunded>providerPaid)throw new Error('Refund accounting invariant violated: refunded cash exceeds the amount paid through the payment provider.');
    return providerPaid-refunded;
}

function assertProviderRefund({providerPaidMinor:paid,refundedMinor=0,requestedMinor}){
    const requested=nonNegativeMinor(requestedMinor,'Requested refund');
    const remaining=remainingProviderRefundableMinor({providerPaidMinor:paid,refundedMinor});
    if(requested>remaining){
        const error=new Error('Cash refund cannot exceed the money actually paid through the payment provider. Affiliate/service credit is not refundable as cash.');
        error.code='REFUND_EXCEEDS_PROVIDER_CASH_PAID';
        throw error;
    }
    return{requestedMinor:requested,remainingBeforeMinor:remaining,remainingAfterMinor:remaining-requested};
}

function assertObservedProviderRefund({providerPaidMinor:paid,refundedMinor}){
    const providerPaid=nonNegativeMinor(paid,'Provider-paid amount');
    const refunded=nonNegativeMinor(refundedMinor,'Provider-refunded amount');
    if(refunded>providerPaid)throw new Error('Provider refund exceeds the money originally paid through that provider. Affiliate/service credit must never be included in a cash refund.');
    return{providerPaidMinor:providerPaid,refundedMinor:refunded,remainingMinor:providerPaid-refunded};
}

module.exports={nonNegativeMinor,providerCashPaidMinor,remainingProviderRefundableMinor,assertProviderRefund,assertObservedProviderRefund};
