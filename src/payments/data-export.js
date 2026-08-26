'use strict';

const { query } = require('../db');
const historyAccounting = require('./history-accounting');

const MAX_TRANSACTION_EXPORT_ROWS = 250000;
const UTF8_BOM = '\uFEFF';

function text(value) { return String(value == null ? '' : value); }
function excelSafe(value) {
    const raw = text(value);
    if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return raw;
    return /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
}

function csvCell(value) {
    const raw = excelSafe(value);
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}
function csv(headers, rows) {
    const lines = [headers.map(csvCell).join(',')];
    for (const row of rows) lines.push(headers.map(header => csvCell(row[header])).join(','));
    return UTF8_BOM + lines.join('\r\n') + '\r\n';
}
function iso(value) {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
function currencyDigits(currency) {
    try { return new Intl.NumberFormat('en', { style: 'currency', currency: String(currency || 'USD').toUpperCase(), currencyDisplay: 'narrowSymbol' }).resolvedOptions().maximumFractionDigits; }
    catch (_) { return 2; }
}
function major(minor, currency) {
    const digits = currencyDigits(currency);
    return (Number(minor || 0) / (10 ** digits)).toFixed(digits);
}
function portableAmount(minor, currency) {
    const code = String(currency || 'USD').toUpperCase();
    const amount = major(minor, code);
    if (code === 'USD') return `$${amount}`;
    if (code === 'GBP') return `£${amount}`;
    if (code === 'EUR') return `€${amount}`;
    return `${code} ${amount}`;
}
function snapshotObject(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch (_) { return {}; }
}
function portablePlanName(row) {
    const snapshot = snapshotObject(row.commercial_snapshot);
    let name = text(snapshot.legacyPlanName || row.plan_name || row.plan_code || 'Paid plan').trim();
    const streams = Number(snapshot.streams || row.plan_streams || 0);
    if (streams > 0 && !/\b\d+\s*streams?\b/i.test(name)) name += ` - ${streams} Streams`;
    return name;
}
function portableTransactionId(row) {
    return text(row.legacy_transaction_id).trim() || `captainfin-sub-${row.subscription_id}`;
}
function portableProcessor(row) {
    if (row.legacy_transaction_id && ['stripe', 'paypal', 'manual'].includes(String(row.legacy_provider || '').toLowerCase())) return String(row.legacy_provider).toLowerCase();
    return 'manual';
}
function providerLabel(value) {
    const provider = String(value || '').toLowerCase();
    return provider === 'stripe' ? 'Stripe' : provider === 'paypal' ? 'PayPal' : 'Manual';
}

async function loadUsers() {
    const result = await query(`
        SELECT c.id::text AS customer_id,
               COALESCE(NULLIF(c.email,''),NULLIF(u.email,''),'') AS email,
               COALESCE(
                 NULLIF((SELECT MIN(ja.jellyfin_username) FROM jellyfin_accounts ja WHERE ja.customer_id=c.id AND COALESCE(ja.account_purpose,'jellyfin')='jellyfin'),''),
                 NULLIF(u.username,''),NULLIF(c.display_name,''),'Customer'
               ) AS export_name,
               COALESCE(u.username,'') AS portal_username,
               COALESCE(c.display_name,'') AS display_name,
               COALESCE((SELECT string_agg(DISTINCT ja.jellyfin_username,' | ' ORDER BY ja.jellyfin_username) FROM jellyfin_accounts ja WHERE ja.customer_id=c.id AND COALESCE(ja.account_purpose,'jellyfin')='jellyfin'),'') AS jellyfin_usernames,
               (SELECT MAX(s.current_period_end) FROM subscriptions s WHERE s.customer_id=c.id AND s.superseded_by IS NULL AND s.status IN ('active','trialing','past_due','paused')) AS expiration,
               c.created_at
          FROM customers c
          LEFT JOIN app_users u ON u.id=c.user_id
         ORDER BY lower(COALESCE(NULLIF(c.email,''),NULLIF(u.email,''),c.display_name,'')),c.id
    `);
    return result.rows;
}

async function loadPortablePayments() {
    const result = await query(`
        SELECT s.id::text AS subscription_id,s.customer_id::text AS customer_id,
               COALESCE(NULLIF(c.email,''),NULLIF(u.email,''),'') AS email,
               p.name AS plan_name,p.code AS plan_code,p.streams AS plan_streams,
               s.status,s.source,s.provider_subscription_id,s.provider_customer_id,s.provider_price_id,
               s.starts_at,s.current_period_end,s.commercial_snapshot,
               COALESCE(s.price_minor_snapshot,p.price_minor,0) AS amount_minor,
               COALESCE(NULLIF(s.currency_snapshot,''),NULLIF(p.currency,''),'USD') AS currency,
               li.provider AS legacy_provider,li.provider_transaction_id AS legacy_transaction_id,li.legacy_payment_id
          FROM subscriptions s
          JOIN plans p ON p.id=s.plan_id
          JOIN customers c ON c.id=s.customer_id
          LEFT JOIN app_users u ON u.id=c.user_id
          LEFT JOIN LATERAL (
             SELECT lsi.provider,lsi.provider_transaction_id,lsi.legacy_payment_id
               FROM legacy_subscription_imports lsi
              WHERE lsi.subscription_id=s.id
              ORDER BY lsi.period_end DESC,lsi.period_start DESC
              LIMIT 1
          ) li ON TRUE
         WHERE s.superseded_by IS NULL
           AND s.current_period_end>NOW()
           AND s.status IN ('active','trialing','past_due','paused')
           AND COALESCE(s.price_minor_snapshot,p.price_minor,0)>0
         ORDER BY s.starts_at,c.id,s.id
    `);
    return result.rows;
}

async function loadTransactions() {
    const result = await query(`
        SELECT t.id::text,t.provider,t.provider_transaction_id,t.transaction_type,t.transaction_status,t.occurred_at,t.currency,
               t.gross_amount_minor,t.fee_amount_minor,t.net_amount_minor,t.provider_customer_id,t.provider_reference_id,t.provider_source_id,
               t.customer_id::text,COALESCE(NULLIF(c.email,''),NULLIF(u.email,''),'') AS customer_email,
               COALESCE(u.username,'') AS portal_username,COALESCE(c.display_name,'') AS display_name
          FROM payment_history_transactions t
          LEFT JOIN customers c ON c.id=t.customer_id
          LEFT JOIN app_users u ON u.id=c.user_id
         ORDER BY t.occurred_at,t.id
         LIMIT $1
    `, [MAX_TRANSACTION_EXPORT_ROWS + 1]);
    if (result.rows.length > MAX_TRANSACTION_EXPORT_ROWS) {
        throw new Error(`Transaction export exceeds the ${MAX_TRANSACTION_EXPORT_ROWS.toLocaleString('en-GB')} row safety limit. Export a narrower provider history dataset or archive older accounting records first.`);
    }
    return result.rows;
}

function usersCsv(rows) {
    const headers = ['ID','Name','Email','Expiration','Customer ID','Portal Username','Display Name','Jellyfin Usernames','Created At'];
    return csv(headers, rows.map(row => ({
        'ID': row.customer_id,
        'Name': row.export_name,
        'Email': row.email,
        'Expiration': iso(row.expiration),
        'Customer ID': row.customer_id,
        'Portal Username': row.portal_username,
        'Display Name': row.display_name,
        'Jellyfin Usernames': row.jellyfin_usernames,
        'Created At': iso(row.created_at)
    })));
}

function paymentsCsv(rows) {
    const headers = ['ID','Email','Plan','Date','Transaction ID','Processor','Type','Amount','From','To','Subscription ID','Original Source','Provider Subscription ID','Provider Customer ID','Provider Price ID','Amount Minor','Currency'];
    return csv(headers, rows.map(row => ({
        'ID': row.subscription_id,
        'Email': row.email,
        'Plan': portablePlanName(row),
        'Date': iso(row.starts_at),
        'Transaction ID': portableTransactionId(row),
        'Processor': providerLabel(portableProcessor(row)),
        'Type': 'Payment',
        'Amount': portableAmount(row.amount_minor,row.currency),
        'From': iso(row.starts_at),
        'To': iso(row.current_period_end),
        'Subscription ID': row.subscription_id,
        'Original Source': row.source || '',
        'Provider Subscription ID': row.provider_subscription_id || '',
        'Provider Customer ID': row.provider_customer_id || '',
        'Provider Price ID': row.provider_price_id || '',
        'Amount Minor': row.amount_minor,
        'Currency': String(row.currency || '').toUpperCase()
    })));
}

function transactionsCsv(rows, { reportingCurrency = null, convertMinor = null, currencyState = null } = {}) {
    const reportCode = reportingCurrency ? String(reportingCurrency).toUpperCase() : '';
    const headers = ['Occurred At','Provider','Classification','Provider Type','Provider Status','Customer Email','Portal Username','Provider Transaction ID','Provider Reference ID','Provider Source ID','Original Currency','Gross Amount','Fee Amount','Net Amount','Gross Minor','Fee Minor','Net Minor','Reporting Currency','Reporting Gross Amount'];
    return csv(headers, rows.map(row => {
        const kind = historyAccounting.historyKind(row) || 'ignored';
        let reportMinor = null;
        if (reportCode && typeof convertMinor === 'function') {
            try { reportMinor = convertMinor(row.gross_amount_minor,row.currency,reportCode,currencyState); } catch (_) { reportMinor = null; }
        }
        return {
            'Occurred At': iso(row.occurred_at),
            'Provider': providerLabel(row.provider),
            'Classification': kind,
            'Provider Type': row.transaction_type || '',
            'Provider Status': row.transaction_status || '',
            'Customer Email': row.customer_email || '',
            'Portal Username': row.portal_username || '',
            'Provider Transaction ID': row.provider_transaction_id || '',
            'Provider Reference ID': row.provider_reference_id || '',
            'Provider Source ID': row.provider_source_id || '',
            'Original Currency': String(row.currency || '').toUpperCase(),
            'Gross Amount': major(row.gross_amount_minor,row.currency),
            'Fee Amount': major(row.fee_amount_minor,row.currency),
            'Net Amount': major(row.net_amount_minor,row.currency),
            'Gross Minor': row.gross_amount_minor,
            'Fee Minor': row.fee_amount_minor,
            'Net Minor': row.net_amount_minor,
            'Reporting Currency': reportCode,
            'Reporting Gross Amount': reportMinor == null ? '' : major(reportMinor,reportCode)
        };
    }));
}

async function summary() {
    const [customers, payments, transactions] = await Promise.all([
        query(`SELECT COUNT(*)::bigint AS total FROM customers`),
        query(`SELECT COUNT(*)::bigint AS total FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.superseded_by IS NULL AND s.current_period_end>NOW() AND s.status IN ('active','trialing','past_due','paused') AND COALESCE(s.price_minor_snapshot,p.price_minor,0)>0`),
        query(`SELECT COUNT(*)::bigint AS total FROM payment_history_transactions`)
    ]);
    return { customers: Number(customers.rows[0]?.total || 0), portablePayments: Number(payments.rows[0]?.total || 0), transactions: Number(transactions.rows[0]?.total || 0) };
}

async function auditExport(actorUserId, kind, counts = {}) {
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.data_export.download','data_export',$2,$3::jsonb)`, [actorUserId || null, String(kind || 'unknown').slice(0,80), JSON.stringify({ kind, ...counts, secretsIncluded: false })]);
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}
function zipStore(files, date = new Date()) {
    const locals = [], centrals = [];
    let offset = 0;
    const { dosTime, dosDate } = dosDateTime(date);
    for (const file of files) {
        const name = Buffer.from(String(file.name), 'utf8');
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0x0800,6); local.writeUInt16LE(0,8);
        local.writeUInt16LE(dosTime,10); local.writeUInt16LE(dosDate,12); local.writeUInt32LE(crc,14); local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(name.length,26); local.writeUInt16LE(0,28);
        locals.push(local,name,data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0x0800,8); central.writeUInt16LE(0,10);
        central.writeUInt16LE(dosTime,12); central.writeUInt16LE(dosDate,14); central.writeUInt32LE(crc,16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(name.length,28);
        central.writeUInt16LE(0,30); central.writeUInt16LE(0,32); central.writeUInt16LE(0,34); central.writeUInt16LE(0,36); central.writeUInt32LE(0,38); central.writeUInt32LE(offset,42);
        centrals.push(central,name);
        offset += local.length + name.length + data.length;
    }
    const centralBuffer = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(0,4); end.writeUInt16LE(0,6); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10);
    end.writeUInt32LE(centralBuffer.length,12); end.writeUInt32LE(offset,16); end.writeUInt16LE(0,20);
    return Buffer.concat([...locals,centralBuffer,end]);
}

module.exports = {
    MAX_TRANSACTION_EXPORT_ROWS,csv,major,portableAmount,portablePlanName,portableTransactionId,portableProcessor,
    loadUsers,loadPortablePayments,loadTransactions,usersCsv,paymentsCsv,transactionsCsv,summary,auditExport,zipStore
};
