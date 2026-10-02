'use strict';

// Financial calendar dates (PostgreSQL DATE) are business/provider calendar
// labels, not instants. Database readers must cast DATE columns to text before
// they cross into Node. These helpers turn that canonical YYYY-MM-DD text into
// explicit UTC boundaries only when interval arithmetic is required.

const DATE_TEXT=/^\d{4}-\d{2}-\d{2}$/;

function text(value){
  if(value instanceof Date){
    if(Number.isNaN(value.getTime()))return null;
    return value.toISOString().slice(0,10);
  }
  const candidate=String(value??'').trim().slice(0,10);
  if(!DATE_TEXT.test(candidate))return null;
  const parsed=new Date(`${candidate}T00:00:00.000Z`);
  if(Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==candidate)return null;
  return candidate;
}

function startUtc(value){
  const valueText=text(value);
  return valueText?new Date(`${valueText}T00:00:00.000Z`):null;
}

function addDaysUtc(value,days){
  const start=startUtc(value);
  if(!start)return null;
  return new Date(start.getTime()+Number(days||0)*86400000);
}

module.exports={text,startUtc,addDaysUtc};
