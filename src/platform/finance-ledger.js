'use strict';

const { query, transaction } = require('../db');
const reporting = require('./reporting-currency');
const providerSettings = require('../payments/provider-settings');
const paymentFinancials = require('../payments/payment-financials');
const { revenueFromEvent } = require('./admin-dashboard-analytics');

const CADENCE_MONTHS = Object.freeze({ monthly:1, quarterly:3, six_monthly:6, yearly:12 });
const CATEGORIES = Object.freeze(['hosting','infrastructure','software','domain','marketing','contractor','other']);
let headerCache = null;
let headerCacheUntil = 0;
let headerPromise = null;
let stripeClient = null;
let stripeClientKey = null;

function invalidateCache(){headerCache=null;headerCacheUntil=0;}
function isoDate(value){const text=String(value||'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return null;const d=new Date(`${text}T00:00:00.000Z`);return Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==text?null:text;}
function moneyToMinor(value){const text=String(value??'').trim();if(!/^\d+(?:\.\d{1,2})?$/.test(text))throw new Error('Enter a valid non-negative amount with up to 2 decimal places.');const [whole,fraction='']=text.split('.');const minor=Number(whole)*100+Number((fraction+'00').slice(0,2));if(!Number.isSafeInteger(minor)||minor<0||minor>999999999999)throw new Error('Expense amount is outside the supported range.');return minor;}
function cleanText(value,max,label,{required=false}={}){const text=String(value||'').trim();if(required&&!text)throw new Error(`${label} is required.`);if(text.length>max)throw new Error(`${label} must be ${max} characters or fewer.`);return text;}
function cleanCadence(value){const cadence=String(value||'').trim();if(!CADENCE_MONTHS[cadence])throw new Error('Choose monthly, quarterly, six-monthly or yearly billing.');return cadence;}
function cleanCategory(value){const category=String(value||'').trim().toLowerCase();return CATEGORIES.includes(category)?category:'other';}
function cleanReminderDays(value){const n=Number(value);if(!Number.isInteger(n)||n<0||n>365)throw new Error('Reminder lead time must be between 0 and 365 days.');return n;}
function booleanValue(value){return value===true||value==='1'||value==='true'||value==='on';}
function addMonthsIso(dateText,months){const [year,month,day]=dateText.split('-').map(Number);const target=new Date(Date.UTC(year,month-1+months,1));const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();target.setUTCDate(Math.min(day,last));return target.toISOString().slice(0,10);}
function defaultRenewal(effectiveFrom,cadence){return addMonthsIso(effectiveFrom,CADENCE_MONTHS[cadence]);}

function normalizeExpenseInput(input={}){
  const name=cleanText(input.name,120,'Expense name',{required:true});
  const vendor=cleanText(input.vendor,120,'Vendor');
  const notes=cleanText(input.notes,1000,'Notes');
  const amountMinor=moneyToMinor(input.amount);
  const currency=reporting.assertCurrency(input.currency);
  const cadence=cleanCadence(input.cadence);
  const category=cleanCategory(input.category);
  const effectiveFrom=isoDate(input.effectiveFrom||input.effective_from);
  if(!effectiveFrom)throw new Error('Choose a valid effective-from date.');
  const renewalInput=String(input.nextRenewalDate||input.next_renewal_date||'').trim();
  const nextRenewalDate=renewalInput?isoDate(renewalInput):defaultRenewal(effectiveFrom,cadence);
  if(renewalInput&&!nextRenewalDate)throw new Error('Choose a valid next renewal/expiry date.');
  if(nextRenewalDate&&nextRenewalDate<effectiveFrom)throw new Error('Renewal/expiry date cannot be before the expense starts.');
  return{name,vendor:vendor||null,notes:notes||null,amountMinor,currency,cadence,category,effectiveFrom,nextRenewalDate,autoRenews:booleanValue(input.autoRenews??input.auto_renews),reminderDays:cleanReminderDays(input.reminderDays??input.reminder_days??30)};
}

async function audit(client,actorUserId,action,entityId,metadata={}){await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'finance_expense',$3,$4::jsonb)`,[actorUserId,action,entityId,JSON.stringify(metadata)]);}

async function createExpense(input,actorUserId=null){
  const value=normalizeExpenseInput(input);
  const row=await transaction(async client=>{
    const inserted=await client.query(`INSERT INTO finance_expenses(series_id,version,name,vendor,category,amount_minor,currency,cadence,effective_from,next_renewal_date,auto_renews,reminder_days,notes,created_by) VALUES(gen_random_uuid(),1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[value.name,value.vendor,value.category,value.amountMinor,value.currency,value.cadence,value.effectiveFrom,value.nextRenewalDate,value.autoRenews,value.reminderDays,value.notes,actorUserId]);
    await audit(client,actorUserId,'admin.finance.expense.create',inserted.rows[0].id,{seriesId:inserted.rows[0].series_id,amountMinor:value.amountMinor,currency:value.currency,cadence:value.cadence,effectiveFrom:value.effectiveFrom,nextRenewalDate:value.nextRenewalDate});
    return inserted.rows[0];
  });
  invalidateCache();return row;
}

async function currentExpenseForUpdate(client,id){const result=await client.query(`SELECT * FROM finance_expenses WHERE id=$1 FOR UPDATE`,[id]);if(!result.rowCount)throw new Error('Expense not found.');const row=result.rows[0];if(row.effective_until)throw new Error('Historical expense versions cannot be changed. Open the current version instead.');return row;}

async function changeExpense(id,input,actorUserId=null){
  const value=normalizeExpenseInput(input);
  const row=await transaction(async client=>{
    const current=await currentExpenseForUpdate(client,id);
    const currentStart=String(current.effective_from).slice(0,10);
    if(value.effectiveFrom<currentStart)throw new Error('A change cannot become effective before the current version started.');
    if(value.effectiveFrom===currentStart){
      const updated=await client.query(`UPDATE finance_expenses SET name=$2,vendor=$3,category=$4,amount_minor=$5,currency=$6,cadence=$7,next_renewal_date=$8,auto_renews=$9,reminder_days=$10,notes=$11,updated_at=NOW() WHERE id=$1 RETURNING *`,[id,value.name,value.vendor,value.category,value.amountMinor,value.currency,value.cadence,value.nextRenewalDate,value.autoRenews,value.reminderDays,value.notes]);
      await audit(client,actorUserId,'admin.finance.expense.correct',id,{amountMinor:value.amountMinor,currency:value.currency,cadence:value.cadence,effectiveFrom:value.effectiveFrom});
      return updated.rows[0];
    }
    await client.query(`UPDATE finance_expenses SET effective_until=$2,next_renewal_date=NULL,updated_at=NOW() WHERE id=$1`,[id,value.effectiveFrom]);
    const inserted=await client.query(`INSERT INTO finance_expenses(series_id,version,name,vendor,category,amount_minor,currency,cadence,effective_from,next_renewal_date,auto_renews,reminder_days,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[current.series_id,Number(current.version)+1,value.name,value.vendor,value.category,value.amountMinor,value.currency,value.cadence,value.effectiveFrom,value.nextRenewalDate,value.autoRenews,value.reminderDays,value.notes,actorUserId]);
    await audit(client,actorUserId,'admin.finance.expense.change',inserted.rows[0].id,{seriesId:current.series_id,previousVersionId:id,amountMinor:value.amountMinor,currency:value.currency,cadence:value.cadence,effectiveFrom:value.effectiveFrom});
    return inserted.rows[0];
  });
  invalidateCache();return row;
}

async function cancelExpense(id,endDate,actorUserId=null){
  const end=isoDate(endDate);if(!end)throw new Error('Choose a valid cancellation/end date.');
  const row=await transaction(async client=>{
    const current=await currentExpenseForUpdate(client,id),start=String(current.effective_from).slice(0,10);
    if(end<start)throw new Error('Cancellation cannot be before the expense started.');
    const updated=await client.query(`UPDATE finance_expenses SET effective_until=$2,next_renewal_date=NULL,auto_renews=FALSE,updated_at=NOW() WHERE id=$1 RETURNING *`,[id,end]);
    await audit(client,actorUserId,'admin.finance.expense.cancel',id,{seriesId:current.series_id,effectiveUntil:end});
    return updated.rows[0];
  });
  invalidateCache();return row;
}

async function updateRenewal(id,{nextRenewalDate,reminderDays,autoRenews},actorUserId=null){
  const renewal=isoDate(nextRenewalDate);if(!renewal)throw new Error('Choose a valid renewal/expiry date.');const reminder=cleanReminderDays(reminderDays);
  const row=await transaction(async client=>{const current=await currentExpenseForUpdate(client,id),start=String(current.effective_from).slice(0,10);if(renewal<start)throw new Error('Renewal/expiry date cannot be before the expense started.');const updated=await client.query(`UPDATE finance_expenses SET next_renewal_date=$2,reminder_days=$3,auto_renews=$4,updated_at=NOW() WHERE id=$1 RETURNING *`,[id,renewal,reminder,booleanValue(autoRenews)]);await audit(client,actorUserId,'admin.finance.expense.renewal_update',id,{nextRenewalDate:renewal,reminderDays:reminder,autoRenews:booleanValue(autoRenews)});return updated.rows[0];});invalidateCache();return row;
}

async function listExpenses(){const result=await query(`SELECT e.*,CASE WHEN e.effective_until IS NULL THEN TRUE ELSE FALSE END AS is_current FROM finance_expenses e ORDER BY e.series_id,e.version DESC`);return result.rows;}
async function currentExpenses(){const result=await query(`SELECT * FROM finance_expenses WHERE effective_until IS NULL ORDER BY COALESCE(next_renewal_date,'9999-12-31'::date),name`);return result.rows;}

function dateMs(value){if(!value)return null;const text=String(value).slice(0,10);const d=new Date(`${text}T00:00:00.000Z`);return Number.isNaN(d.getTime())?null:d.getTime();}
function annualizedMinor(row){const months=CADENCE_MONTHS[row.cadence];return months?Number(row.amount_minor||0)*(12/months):0;}
function calendarMonthAccrualMinor(row,start,end){
  const rowStart=dateMs(row.effective_from),rowEnd=dateMs(row.effective_until)??Infinity;
  const activeStart=Math.max(rowStart??Infinity,start.getTime()),activeEnd=Math.min(rowEnd,end.getTime());
  if(!Number.isFinite(activeStart)||activeEnd<=activeStart)return 0;
  const monthly=annualizedMinor(row)/12;
  let total=0,cursor=new Date(activeStart);
  cursor=new Date(Date.UTC(cursor.getUTCFullYear(),cursor.getUTCMonth(),1));
  let guard=0;
  while(cursor.getTime()<activeEnd&&guard++<240){
    const monthStart=cursor.getTime(),next=new Date(Date.UTC(cursor.getUTCFullYear(),cursor.getUTCMonth()+1,1)),monthEnd=next.getTime();
    const overlapStart=Math.max(activeStart,monthStart),overlapEnd=Math.min(activeEnd,monthEnd);
    if(overlapEnd>overlapStart)total+=monthly*((overlapEnd-overlapStart)/(monthEnd-monthStart));
    cursor=next;
  }
  return Math.round(total);
}
function expenseAccrual(rows,start,end,reportingState,targetCurrency){let minor=0;for(const row of rows){const accrued=calendarMonthAccrualMinor(row,start,end);if(accrued<=0)continue;minor+=reporting.convertMinor(accrued,row.currency,targetCurrency,reportingState);}return minor;}
function currentExpenseRunRate(rows,reportingState,targetCurrency){let monthly=0,yearly=0;for(const row of rows.filter(r=>!r.effective_until)){const annual=annualizedMinor(row);yearly+=reporting.convertMinor(annual,row.currency,targetCurrency,reportingState);monthly+=reporting.convertMinor(Math.round(annual/12),row.currency,targetCurrency,reportingState);}return{monthlyMinor:monthly,yearlyMinor:yearly};}

function financeRevenueFromEvent(row){
  const known=revenueFromEvent(row);if(known)return known;
  if(row.provider!=='plisio'||String(row.event_type||'').toLowerCase()!=='operation.completed')return null;
  const payload=row.payload||{};const minor=paymentFinancials.decimalToMinor(payload.source_amount??payload.amount??payload.invoice_total);if(minor==null||minor<0)return null;const currency=paymentFinancials.cleanCurrency(payload.source_currency||payload.currency);if(!currency)return null;return{minor,currency,email:null};
}

async function configuredStripe(){const config=await providerSettings.get('stripe'),key=config?.restrictedKey||config?.apiKey||'';if(!key)return null;if(!stripeClient||stripeClientKey!==key){const Stripe=require('stripe');stripeClient=new Stripe(key,{apiVersion:'2026-06-24.dahlia',appInfo:{name:'CAPTAiNFiN',version:'1.0.0'}});stripeClientKey=key;}return stripeClient;}

async function enrichFinancialRows(rows,{stripeLimit=0}={}){
  let stripe=null,stripeUsed=0;
  for(const row of rows){
    if(row.fee_minor!=null)continue;
    if(row.fee_source==='unavailable'&&row.provider!=='stripe')continue;
    try{
      if(row.provider==='paypal'){
        const event=row.payload&&row.payload.event_type?row.payload:{...(row.payload||{}),id:row.provider_event_id,event_type:row.event_type};const values=paymentFinancials.paypalEventValues(event);if(values){const saved=await paymentFinancials.record({provider:'paypal',providerEventId:row.provider_event_id,eventType:row.event_type,...values,feeSource:values.feeMinor==null?'unavailable':'provider_actual'});if(saved){row.fee_minor=saved.fee_minor;row.financial_currency=saved.currency;row.fee_source=saved.fee_source;}}
      }else if(row.provider==='plisio'){
        const saved=await paymentFinancials.plisioOperationFinancials({eventId:row.provider_event_id,eventType:row.event_type,remote:row.payload||{},fallback:{sourceAmount:row.payload?.source_amount,sourceCurrency:row.payload?.source_currency}});if(saved){row.fee_minor=saved.fee_minor;row.financial_currency=saved.currency;row.fee_source=saved.fee_source;}
      }else if(row.provider==='stripe'&&stripeUsed<stripeLimit){
        if(!stripe)stripe=await configuredStripe();if(!stripe)continue;stripeUsed+=1;const event=row.payload&&row.payload.type?row.payload:{...(row.payload||{}),id:row.provider_event_id,type:row.event_type};const saved=await paymentFinancials.stripeEventFinancials(event,stripe);if(saved){row.fee_minor=saved.fee_minor;row.financial_currency=saved.currency;row.fee_source=saved.fee_source;}
      }
    }catch(error){console.warn(`Finance fee enrichment failed for ${row.provider} ${row.provider_event_id}:`,error.message);}
  }
  return rows;
}

function converted(minor,currency,target,state){return reporting.convertMinor(Number(minor||0),currency||target,target,state);}
function normalizedAdverseRows(rows){
  const ordered=rows.slice().sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const stripeRefundCumulative=new Map();
  return ordered.map(row=>{
    let effectiveMinor=Number(row.amount_minor||0);
    if(row.provider==='stripe'&&row.incident_type==='refund'){
      const caseKey=String(row.provider_case_id||row.provider_subscription_id||'');
      const prior=caseKey?Number(stripeRefundCumulative.get(caseKey)||0):0;
      const cumulative=Math.max(prior,effectiveMinor);
      effectiveMinor=Math.max(0,cumulative-prior);
      if(caseKey)stripeRefundCumulative.set(caseKey,cumulative);
    }
    return{...row,effective_minor:effectiveMinor};
  });
}
function periodTotals(rows,adverse,start,end,state,currency){let gross=0,fees=0,payments=0,feeKnown=0;for(const row of rows){const at=new Date(row.created_at);if(at<start||at>=end)continue;const sale=financeRevenueFromEvent(row);if(!sale)continue;payments+=1;gross+=converted(sale.minor,sale.currency,currency,state);if(row.fee_minor!=null){fees+=converted(row.fee_minor,row.financial_currency||sale.currency,currency,state);feeKnown+=1;}}
  let reversals=0;for(const row of adverse){const at=new Date(row.created_at);if(at<start||at>=end)continue;reversals+=converted(row.effective_minor,row.currency,currency,state);}return{grossMinor:gross,merchantFeesMinor:fees,reversalsMinor:reversals,netRevenueMinor:gross-fees-reversals,paymentCount:payments,feeKnownCount:feeKnown,feeCoveragePct:payments?Math.round(feeKnown/payments*100):100};}

async function financialSummary({now=new Date(),stripeBackfillLimit=0}={}){
  const yearStart=new Date(Date.UTC(now.getUTCFullYear(),0,1)),monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)),end=new Date(now.getTime()+1);
  const [state,eventResult,adverseResult,expenseResult]=await Promise.all([
    reporting.get(),
    query(`SELECT pe.provider,pe.provider_event_id,pe.event_type,pe.payload,pe.created_at,pf.fee_minor,pf.currency AS financial_currency,pf.fee_source FROM payment_events pe LEFT JOIN payment_financials pf ON pf.provider=pe.provider AND pf.provider_event_id=pe.provider_event_id WHERE pe.provider IN('stripe','paypal','plisio') AND pe.processed_at IS NOT NULL AND pe.processing_error IS NULL AND pe.created_at>=$1 AND pe.created_at<$2 ORDER BY pe.created_at DESC LIMIT 50000`,[yearStart,end]),
    query(`SELECT provider,provider_event_id,provider_case_id,provider_subscription_id,incident_type,incident_status,amount_minor,currency,created_at FROM payment_incidents WHERE amount_minor IS NOT NULL AND (incident_type='refund' OR (incident_type='chargeback' AND incident_status='lost')) ORDER BY created_at ASC LIMIT 50000`),
    query(`SELECT * FROM finance_expenses WHERE effective_from<=$2::date AND (effective_until IS NULL OR effective_until>$1::date) ORDER BY effective_from`,[yearStart,end])
  ]);
  const currency=reporting.cleanCurrency(state.currency),events=await enrichFinancialRows(eventResult.rows,{stripeLimit:Math.max(0,Math.min(100,Number(stripeBackfillLimit)||0))}),adverse=normalizedAdverseRows(adverseResult.rows),expenses=expenseResult.rows;
  const month=periodTotals(events,adverse,monthStart,end,state,currency),year=periodTotals(events,adverse,yearStart,end,state,currency);
  month.operatingExpensesMinor=expenseAccrual(expenses,monthStart,end,state,currency);year.operatingExpensesMinor=expenseAccrual(expenses,yearStart,end,state,currency);
  month.profitMinor=month.netRevenueMinor-month.operatingExpensesMinor;year.profitMinor=year.netRevenueMinor-year.operatingExpensesMinor;
  month.profitMarginPct=month.grossMinor?month.profitMinor/month.grossMinor*100:null;year.profitMarginPct=year.grossMinor?year.profitMinor/year.grossMinor*100:null;
  const runRate=currentExpenseRunRate(expenses,state,currency);
  return{currency,month,year,runRate,generatedAt:new Date().toISOString()};
}

async function headerFinancialSummary(){const now=Date.now();if(headerCache&&now<headerCacheUntil)return headerCache;if(headerPromise)return headerPromise;headerPromise=financialSummary({stripeBackfillLimit:2}).then(value=>{headerCache=value;headerCacheUntil=Date.now()+30000;return value;}).finally(()=>{headerPromise=null;});return headerPromise;}

async function upcomingRenewals(days=90){const limit=Math.max(1,Math.min(365,Number(days)||90));const result=await query(`SELECT *, (next_renewal_date-CURRENT_DATE)::int AS days_until FROM finance_expenses WHERE effective_until IS NULL AND next_renewal_date IS NOT NULL AND next_renewal_date<=CURRENT_DATE+($1::int) ORDER BY next_renewal_date,name`,[limit]);return result.rows;}
async function renewalReminderSummary(){const result=await query(`SELECT COUNT(*)::int n,MIN(next_renewal_date) AS next_date,MAX(updated_at) AS updated FROM finance_expenses WHERE effective_until IS NULL AND next_renewal_date IS NOT NULL AND next_renewal_date<=CURRENT_DATE+(reminder_days::int)`);return{count:Number(result.rows[0]?.n||0),nextDate:result.rows[0]?.next_date||null,updatedAt:result.rows[0]?.updated||null};}

module.exports={CADENCE_MONTHS,CATEGORIES,isoDate,moneyToMinor,normalizeExpenseInput,addMonthsIso,defaultRenewal,createExpense,changeExpense,cancelExpense,updateRenewal,listExpenses,currentExpenses,annualizedMinor,calendarMonthAccrualMinor,expenseAccrual,currentExpenseRunRate,financeRevenueFromEvent,enrichFinancialRows,normalizedAdverseRows,financialSummary,headerFinancialSummary,upcomingRenewals,renewalReminderSummary,invalidateCache};
