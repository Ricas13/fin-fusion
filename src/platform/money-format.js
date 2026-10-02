'use strict';

const COMMON=Object.freeze({
  GBP:{name:'British Pound',symbol:'£'},
  USD:{name:'US Dollar',symbol:'$'},
  EUR:{name:'Euro',symbol:'€'}
});

function cleanCurrency(value,fallback='GBP'){
  const code=String(value||fallback).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code)?code:String(fallback||'GBP').trim().toUpperCase();
}

function fractionDigits(currency='GBP'){
  const code=cleanCurrency(currency);
  try{
    return new Intl.NumberFormat('en-GB',{style:'currency',currency:code,currencyDisplay:'narrowSymbol'}).resolvedOptions().maximumFractionDigits;
  }catch{return 2;}
}

function symbol(currency='GBP'){
  const code=cleanCurrency(currency);
  if(COMMON[code])return COMMON[code].symbol;
  try{
    const part=new Intl.NumberFormat('en-GB',{style:'currency',currency:code,currencyDisplay:'narrowSymbol',minimumFractionDigits:0,maximumFractionDigits:0}).formatToParts(0).find(item=>item.type==='currency');
    return String(part?.value||'¤');
  }catch{return'¤';}
}

function formatMajor(amount,currency='GBP',options={}){
  const code=cleanCurrency(currency),numeric=Number(amount);
  if(!Number.isFinite(numeric))return `${symbol(code)}${String(amount??'').trim()}`;
  const minimumFractionDigits=options.minimumFractionDigits??2;
  const maximumFractionDigits=options.maximumFractionDigits??2;
  try{
    return new Intl.NumberFormat('en-GB',{style:'currency',currency:code,currencyDisplay:'narrowSymbol',minimumFractionDigits,maximumFractionDigits}).format(numeric);
  }catch{return `${symbol(code)}${numeric.toFixed(Math.min(20,Math.max(0,maximumFractionDigits)))}`;}
}

function majorFromMinor(minor,currency='GBP'){
  void currency;
  return Number(minor||0)/100;
}

function formatMinor(minor,currency='GBP',options={}){
  const numeric=Number(minor||0);
  const trimZeroDecimals=Boolean(options.trimZeroDecimals);
  const hasMinor=Number.isFinite(numeric)&&Math.abs(numeric)%100!==0;
  return formatMajor(majorFromMinor(numeric,currency),currency,{
    minimumFractionDigits:options.minimumFractionDigits??(trimZeroDecimals&&!hasMinor?0:2),
    maximumFractionDigits:options.maximumFractionDigits??2
  });
}

function currencyMajorFromMinor(minor,currency='GBP'){
  return Number(minor||0)/(10**fractionDigits(currency));
}

function formatCurrencyMinor(minor,currency='GBP',options={}){
  const digits=fractionDigits(currency);
  return formatMajor(currencyMajorFromMinor(minor,currency),currency,{
    minimumFractionDigits:options.minimumFractionDigits??digits,
    maximumFractionDigits:options.maximumFractionDigits??digits
  });
}

function currencyMinorDecimal(minor,currency='GBP'){
  const digits=fractionDigits(currency);
  return currencyMajorFromMinor(minor,currency).toFixed(digits);
}

function parseMajorToMinor(value,{allowNegative=false,allowZero=true,error='Enter a valid amount with up to two decimal places.'}={}){
  const raw=String(value??'').trim();
  const sign=allowNegative?'-?':'';
  if(!new RegExp(`^${sign}\\d+(?:\\.\\d{1,2})?$`).test(raw))throw new Error(error);
  const minor=Math.round(Number(raw)*100);
  if(!Number.isSafeInteger(minor)||(!allowZero&&minor===0)||(!allowNegative&&minor<0))throw new Error(error);
  return minor;
}

function portableAmount(minor,currency='GBP'){
  const code=cleanCurrency(currency,'USD');
  const amount=currencyMinorDecimal(minor,code);
  if(code==='USD')return `$${amount}`;
  if(code==='GBP')return `£${amount}`;
  if(code==='EUR')return `€${amount}`;
  return `${code} ${amount}`;
}

function optionLabel(currency){
  const code=cleanCurrency(currency);
  const known=COMMON[code];
  return known?`${known.name} (${known.symbol})`:`${symbol(code)} currency`;
}

module.exports={COMMON,cleanCurrency,fractionDigits,symbol,formatMajor,majorFromMinor,formatMinor,currencyMajorFromMinor,formatCurrencyMinor,currencyMinorDecimal,parseMajorToMinor,portableAmount,optionLabel};
