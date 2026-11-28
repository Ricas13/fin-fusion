'use strict';

// Monetary quote only. No entitlement or credit writes, no reporting fallback.
const {addPlanDuration}=require('./billing-periods');
const CURRENCIES=new Set(['GBP','USD','EUR']);
const DAY_MS=86400000;
const MAX_RATE_AGE_MS=7*DAY_MS;
const MAX_QUOTE_AGE_MS=5*60*1000;
function currency(value){
 const c=String(value||'').trim().toUpperCase();
 if(!CURRENCIES.has(c))throw new Error('Unsupported transfer currency.');
 return c;
}
function integer(value,label){
 if(value==null||!/^\d{1,40}$/.test(String(value)))throw new Error('Invalid '+label+'.');
 return BigInt(value);
}
function decimal(value){
 const str=String(value??'');
 if(!/^\d{1,8}(?:\.\d{1,18})?$/.test(str))throw new Error('Invalid verified FX rate.');
 const [whole,fraction='']=str.split('.');
 const numerator=BigInt(whole+fraction),denominator=10n**BigInt(fraction.length);
 if(numerator<=0n)throw new Error('Invalid verified FX rate.');
 return {numerator,denominator};
}
function clock(value,label){
 const n=new Date(value??NaN).getTime();
 if(!Number.isSafeInteger(n))throw new Error('Invalid '+label+'.');
 return n;
}
function rateFraction(rate,from,to,now){
 if(from===to)return {numerator:1n,denominator:1n,source:'same_currency',rateDate:null,observedAt:null};
 if(rate?.source!=='frankfurter'||rate.base!==from||rate.quote!==to||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(rate.date||'')))throw new Error('Verified FX rate unavailable.');
 const date=clock(rate.date+'T00:00:00.000Z','FX date'),observed=clock(rate.observedAt,'FX observation');
 if(new Date(date).toISOString().slice(0,10)!==rate.date||date>now||now-date>MAX_RATE_AGE_MS||
    observed>now||now-observed>MAX_QUOTE_AGE_MS||observed<date)throw new Error('FX rate is stale or invalid.');
 return {...decimal(rate.rate),source:rate.source,rateDate:rate.date,observedAt:rate.observedAt};
}
async function fetchRate(from,to,{fetchFn=fetch,now=Date.now}={}){
 from=currency(from);to=currency(to);
 if(from===to)return null;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3500);
 try{
   // Supported codes are strictly allowlisted; no user-supplied URL.
   const url='https://api.frankfurter.dev/v2/rates?base='+from+'&quotes='+to;
   const response=await fetchFn(url,{headers:{Accept:'application/json'},redirect:'error',signal:controller.signal});
   if(!response.ok)throw new Error('FX service unavailable.');
   const rows=await response.json();
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('FX response is ambiguous.');
   const row=rows[0],observedAt=new Date(now()).toISOString();
   const rate={source:'frankfurter',base:row.base,quote:row.quote,date:row.date,rate:String(row.rate),observedAt};
   rateFraction(rate,from,to,clock(observedAt,'FX observation'));
   return rate;
 }finally{clearTimeout(timer);}
}
function quoteConversion(evidence,target,{rate=null,now=new Date(),termStart=null}={}){
 if(evidence?.verified!==true)throw new Error('Unused paid value is not verified.');
 const from=currency(evidence.currency),to=currency(target?.currency),at=clock(now,'quote time');
 const asOf=clock(evidence.asOf,'evidence time');
 if(asOf>at||at-asOf>MAX_QUOTE_AGE_MS)throw new Error('Paid value evidence is stale.');
 const numerator=integer(evidence.remainingValueMinor?.numerator,'remaining value'),denominator=integer(evidence.remainingValueMinor?.denominator,'value denominator');
 if(!denominator||!numerator)throw new Error('No positive unused monetary value.');
 const price=integer(target.normalPriceMinor,'normal destination price');
 if(!price)throw new Error('Destination must have a positive normal price.');
 const interval=String(target.billingInterval||'');
 if(!['month','6_months','year'].includes(interval))throw new Error('Unsupported destination billing term.');
 const start=clock(termStart??evidence.asOf,'destination term start');
 const end=addPlanDuration({billingInterval:interval},new Date(start)).getTime();
 if(!Number.isSafeInteger(end)||end<=start)throw new Error('Invalid destination term.');
 const fx=rateFraction(rate,from,to,at),convertedNumerator=numerator*fx.numerator,convertedDenominator=denominator*fx.denominator;
 // One ceiling at the end, not a rounded monetary conversion followed by another rounding.
 const dayNumerator=convertedNumerator*BigInt(end-start);
 const dayDenominator=convertedDenominator*price*BigInt(DAY_MS);
 const days=(dayNumerator+dayDenominator-1n)/dayDenominator;
 if(days>3650n)throw new Error('Converted access exceeds the supported 3650-day limit; review without losing value.');
 return {quoteOnly:true,sourceCurrency:from,destinationCurrency:to,destinationPriceId:target.priceId||null,
   normalDestinationPriceMinor:price.toString(),destinationBillingInterval:interval,
   sourceRemainingValueMinor:{numerator:numerator.toString(),denominator:denominator.toString()},
   destinationRemainingValueMinor:{numerator:convertedNumerator.toString(),denominator:convertedDenominator.toString()},
   exactDays:{numerator:dayNumerator.toString(),denominator:dayDenominator.toString()},addedDays:Number(days),
   termStartsAt:new Date(start).toISOString(),termEndsAt:new Date(end).toISOString(),asOf:new Date(at).toISOString(),
   fx:{source:fx.source,base:from,quote:to,numerator:fx.numerator.toString(),denominator:fx.denominator.toString(),
      rateDate:fx.rateDate,observedAt:fx.observedAt}};
}
module.exports={fetchRate,quoteConversion};
