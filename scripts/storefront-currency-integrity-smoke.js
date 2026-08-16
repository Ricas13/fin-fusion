'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const pricing=fs.readFileSync(path.join(__dirname,'..','src','payments','plan-pricing.js'),'utf8');
const storefront=fs.readFileSync(path.join(__dirname,'..','src','platform','storefront.js'),'utf8');
const customer=fs.readFileSync(path.join(__dirname,'..','src','platform','customer-dashboard.js'),'utf8');

assert(pricing.includes('async function decoratePlans(plans,currency,{allowFallback=false}={})'),'Plan decoration must require the requested currency by default');
assert(pricing.includes('.filter(row=>allowFallback||Boolean(row.selected))'),'Plans without the requested active currency must be hidden instead of displaying another currency');
assert(storefront.includes('planPricing.decoratePlans(logicalPlans,currency)'),'Storefront must use exact-currency plan decoration');
assert(customer.includes('planPricing.decoratePlans(logical,currency)'),'Customer plan selector must use exact-currency plan decoration');
console.log('storefront currency integrity smoke: ok');
