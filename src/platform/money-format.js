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

function formatMinor(minor,currency='GBP',options={}){
  const numeric=Number(minor||0);
  const trimZeroDecimals=Boolean(options.trimZeroDecimals);
  const hasMinor=Number.isFinite(numeric)&&Math.abs(numeric)%100!==0;
  return formatMajor(numeric/100,currency,{
    minimumFractionDigits:options.minimumFractionDigits??(trimZeroDecimals&&!hasMinor?0:2),
    maximumFractionDigits:options.maximumFractionDigits??2
  });
}

function optionLabel(currency){
  const code=cleanCurrency(currency);
  const known=COMMON[code];
  return known?`${known.name} (${known.symbol})`:`${symbol(code)} currency`;
}

module.exports={COMMON,cleanCurrency,symbol,formatMajor,formatMinor,optionLabel};
