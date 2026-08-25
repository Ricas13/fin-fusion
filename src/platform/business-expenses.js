'use strict';

const { query } = require('../db');

const RECURRENCES = new Set(['one_time','monthly','quarterly','yearly']);

function asDate(value){
  if(value instanceof Date)return new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth(),value.getUTCDate()));
  const text=String(value||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return null;
  const d=new Date(`${text}T00:00:00Z`);
  return Number.isNaN(d.getTime())?null:d;
}
function isoDate(value){const d=asDate(value);return d?d.toISOString().slice(0,10):null;}
function clampDay(year,month,day){return Math.min(day,new Date(Date.UTC(year,month+1,0)).getUTCDate());}
function addMonths(date,months,anchorDay){const total=date.getUTCFullYear()*12+date.getUTCMonth()+months,year=Math.floor(total/12),month=((total%12)+12)%12,day=clampDay(year,month,anchorDay);return new Date(Date.UTC(year,month,day));}
function nextOccurrence(date,recurrence,anchorDay){
  if(recurrence==='monthly')return addMonths(date,1,anchorDay);
  if(recurrence==='quarterly')return addMonths(date,3,anchorDay);
  if(recurrence==='yearly')return addMonths(date,12,anchorDay);
  return null;
}
function occurrences(row,rangeStart,rangeEnd){
  const start=asDate(row.start_date),from=asDate(rangeStart),to=asDate(rangeEnd),limit=row.end_date?asDate(row.end_date):null;
  if(!start||!from||!to||to<=from)return[];
  const recurrence=RECURRENCES.has(row.recurrence)?row.recurrence:'one_time';
  if(recurrence==='one_time')return start>=from&&start<to&&(!limit||start<=limit)?[start]:[];
  const anchorDay=start.getUTCDate(),out=[];let current=start,guard=0;
  while(current<from&&guard++<2400){const next=nextOccurrence(current,recurrence,anchorDay);if(!next||next<=current)break;current=next;}
  guard=0;
  while(current<to&&guard++<2400){if((!limit||current<=limit)&&current>=from)out.push(current);const next=nextOccurrence(current,recurrence,anchorDay);if(!next||next<=current)break;current=next;}
  return out;
}
async function list({includeInactive=true}={}){
  const result=await query(`SELECT * FROM business_expenses ${includeInactive?'':'WHERE active=TRUE'} ORDER BY active DESC,start_date DESC,created_at DESC`);
  return result.rows;
}
async function create(input,createdBy){
  const result=await query(`INSERT INTO business_expenses(name,supplier,category,amount_minor,currency,recurrence,start_date,end_date,active,reference,notes,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[
    input.name,input.supplier||null,input.category,input.amountMinor,input.currency,input.recurrence,input.startDate,input.endDate||null,input.active!==false,input.reference||null,input.notes||null,createdBy||null
  ]);return result.rows[0];
}
async function update(id,input){
  const result=await query(`UPDATE business_expenses SET name=$2,supplier=$3,category=$4,amount_minor=$5,currency=$6,recurrence=$7,start_date=$8,end_date=$9,active=$10,reference=$11,notes=$12,updated_at=NOW() WHERE id=$1 RETURNING *`,[
    id,input.name,input.supplier||null,input.category,input.amountMinor,input.currency,input.recurrence,input.startDate,input.endDate||null,input.active!==false,input.reference||null,input.notes||null
  ]);return result.rows[0]||null;
}
async function remove(id){const result=await query(`DELETE FROM business_expenses WHERE id=$1 RETURNING id`,[id]);return result.rowCount===1;}
function summarize(rows,rangeStart,rangeEnd,convertMinor,targetCurrency){
  let totalMinor=0,count=0;const byCategory=new Map(),bySupplier=new Map(),byCurrency=new Map();
  for(const row of rows){
    if(!row.active)continue;
    const dates=occurrences(row,rangeStart,rangeEnd);if(!dates.length)continue;
    const native=Number(row.amount_minor||0)*dates.length,converted=convertMinor(native,row.currency,targetCurrency);
    totalMinor+=converted;count+=dates.length;
    byCategory.set(row.category,(byCategory.get(row.category)||0)+converted);
    const supplier=String(row.supplier||'Unspecified').trim()||'Unspecified';bySupplier.set(supplier,(bySupplier.get(supplier)||0)+converted);
    byCurrency.set(row.currency,(byCurrency.get(row.currency)||0)+native);
  }
  const sortMap=map=>[...map.entries()].map(([name,amountMinor])=>({name,amountMinor})).sort((a,b)=>b.amountMinor-a.amountMinor);
  return{totalMinor,count,byCategory:sortMap(byCategory),bySupplier:sortMap(bySupplier),byCurrency:sortMap(byCurrency)};
}
function annualWindow(year){const y=Number(year)||new Date().getUTCFullYear();return{start:new Date(Date.UTC(y,0,1)),end:new Date(Date.UTC(y+1,0,1))};}

module.exports={RECURRENCES,asDate,isoDate,occurrences,list,create,update,remove,summarize,annualWindow};
