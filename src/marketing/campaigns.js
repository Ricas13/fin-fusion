'use strict';

const { query, transaction } = require('../db');
const outbox = require('../integrations/email-outbox');

const SEGMENTS = new Set(['no_active_subscription', 'expired_subscription', 'active_subscription', 'all_opted_in']);
const SERVICES = new Set(['jellyfin', 'stremio', 'bundle']);
const PRICE_TYPES = new Set(['free', 'paid']);
const SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused', 'cancelled', 'expired']);
const BILLING_INTERVALS = new Set(['trial', 'month', '6_months', 'year', 'custom']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clean(value, min, max, label) {
    const text = String(value || '').trim();
    if (text.length < min || text.length > max) throw new Error(`${label} must be between ${min} and ${max} characters.`);
    return text;
}
function optionalInt(value, min, max, label) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be between ${min} and ${max}.`);
    return parsed;
}
function optionalEnum(value, allowed, label) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return null;
    if (!allowed.has(text)) throw new Error(`Invalid ${label}.`);
    return text;
}
function optionalUuid(value, label) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (!UUID_RE.test(text)) throw new Error(`Invalid ${label}.`);
    return text;
}
function segment(value) {
    const key = String(value || 'all_opted_in').trim();
    if (!SEGMENTS.has(key)) throw new Error('Invalid marketing audience.');
    return key;
}
function normalizeRules(input = {}) {
    const rules = {};
    const accountAgeDays = optionalInt(input.accountAgeDays, 0, 3650, 'Account age');
    const lapsedDays = optionalInt(input.lapsedDays, 0, 3650, 'Time since last subscription');
    const expiresWithinDays = optionalInt(input.expiresWithinDays, 1, 365, 'Expiry window');
    const inactivePlaybackDays = optionalInt(input.inactivePlaybackDays, 1, 3650, 'Playback inactivity');
    const serviceType = optionalEnum(input.serviceType || input.previousService, SERVICES, 'service type');
    const priceType = optionalEnum(input.priceType, PRICE_TYPES, 'price type');
    const subscriptionStatus = optionalEnum(input.subscriptionStatus, SUBSCRIPTION_STATUSES, 'subscription status');
    const billingInterval = optionalEnum(input.billingInterval, BILLING_INTERVALS, 'billing interval');
    const planId = optionalUuid(input.planId, 'plan');
    if (accountAgeDays !== null) rules.accountAgeDays = accountAgeDays;
    if (lapsedDays !== null) rules.lapsedDays = lapsedDays;
    if (expiresWithinDays !== null) rules.expiresWithinDays = expiresWithinDays;
    if (inactivePlaybackDays !== null) rules.inactivePlaybackDays = inactivePlaybackDays;
    if (serviceType) rules.serviceType = serviceType;
    if (priceType) rules.priceType = priceType;
    if (subscriptionStatus) rules.subscriptionStatus = subscriptionStatus;
    if (billingInterval) rules.billingInterval = billingInterval;
    if (planId) rules.planId = planId;
    return rules;
}
function scheduleTime(value) {
    const parsed = new Date(String(value || ''));
    if (Number.isNaN(parsed.getTime())) throw new Error('Choose a valid campaign schedule time.');
    const minimum = Date.now() + 30_000;
    const maximum = Date.now() + 366 * 24 * 60 * 60 * 1000;
    if (parsed.getTime() < minimum) throw new Error('Schedule the campaign at least 30 seconds in the future.');
    if (parsed.getTime() > maximum) throw new Error('Campaigns can be scheduled up to one year ahead.');
    return parsed;
}
async function validateDiscount(code) {
    const value = String(code || '').trim();
    if (!value) return null;
    const row = (await query(`SELECT code FROM discount_codes WHERE UPPER(code)=UPPER($1) AND active=TRUE AND (expires_at IS NULL OR expires_at>NOW())`, [value])).rows[0];
    if (!row) throw new Error('Choose an active, unexpired discount code.');
    return row.code;
}
function activeSubscriptionSql(alias = 's') {
    return `${alias}.superseded_by IS NULL AND ${alias}.status IN ('active','trialing','past_due','paused') AND ${alias}.starts_at<=NOW() AND (${alias}.current_period_end IS NULL OR ${alias}.current_period_end>NOW())`;
}
function baseSegmentWhere(key) {
    const active = `EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id=c.id AND ${activeSubscriptionSql('s')})`;
    if (key === 'no_active_subscription') return `NOT ${active}`;
    if (key === 'expired_subscription') return `NOT ${active} AND EXISTS (SELECT 1 FROM subscriptions old WHERE old.customer_id=c.id)`;
    if (key === 'active_subscription') return active;
    return 'TRUE';
}
function eligibleQuery(segmentKey, rawRules = {}) {
    const key = segment(segmentKey);
    const rules = normalizeRules(rawRules);
    const params = [];
    const clauses = [baseSegmentWhere(key)];
    const param = value => { params.push(value); return `$${params.length}`; };

    if (rules.accountAgeDays !== undefined) clauses.push(`c.created_at<=NOW()-(${param(rules.accountAgeDays)}::int*INTERVAL '1 day')`);
    if (rules.lapsedDays !== undefined) clauses.push(`EXISTS (SELECT 1 FROM subscriptions hist_lapsed WHERE hist_lapsed.customer_id=c.id HAVING MAX(COALESCE(hist_lapsed.current_period_end,hist_lapsed.created_at))<=NOW()-(${param(rules.lapsedDays)}::int*INTERVAL '1 day'))`);
    if (rules.serviceType) clauses.push(`EXISTS (SELECT 1 FROM subscriptions hist_service JOIN plans hp_service ON hp_service.id=hist_service.plan_id WHERE hist_service.customer_id=c.id AND COALESCE(NULLIF(hist_service.service_type_snapshot,''),hp_service.service_type,'jellyfin')=${param(rules.serviceType)})`);
    if (rules.planId) clauses.push(`EXISTS (SELECT 1 FROM subscriptions hist_plan WHERE hist_plan.customer_id=c.id AND hist_plan.plan_id=${param(rules.planId)}::uuid)`);
    if (rules.priceType) clauses.push(`EXISTS (SELECT 1 FROM subscriptions hist_price JOIN plans hp_price ON hp_price.id=hist_price.plan_id WHERE hist_price.customer_id=c.id AND ${rules.priceType === 'free' ? 'COALESCE(hp_price.price_minor,0)=0' : 'COALESCE(hp_price.price_minor,0)>0'})`);
    if (rules.billingInterval) clauses.push(`EXISTS (SELECT 1 FROM subscriptions hist_bill JOIN plans hp_bill ON hp_bill.id=hist_bill.plan_id WHERE hist_bill.customer_id=c.id AND hp_bill.billing_interval=${param(rules.billingInterval)})`);
    if (rules.subscriptionStatus) clauses.push(`EXISTS (SELECT 1 FROM subscriptions hist_status WHERE hist_status.customer_id=c.id AND hist_status.status=${param(rules.subscriptionStatus)})`);
    if (rules.expiresWithinDays !== undefined) clauses.push(`EXISTS (SELECT 1 FROM subscriptions exp WHERE exp.customer_id=c.id AND ${activeSubscriptionSql('exp')} AND exp.current_period_end IS NOT NULL AND exp.current_period_end<=NOW()+(${param(rules.expiresWithinDays)}::int*INTERVAL '1 day'))`);
    if (rules.inactivePlaybackDays !== undefined) clauses.push(`NOT EXISTS (SELECT 1 FROM playback_history ph WHERE ph.customer_id=c.id AND ph.started_at>=NOW()-(${param(rules.inactivePlaybackDays)}::int*INTERVAL '1 day'))`);

    return { key, rules, params, where: clauses.join(' AND ') };
}
function eligibleIdentitySql(where) {
    return `FROM customers c LEFT JOIN app_users u ON u.id=c.user_id JOIN customer_communication_preferences cp ON cp.customer_id=c.id WHERE cp.marketing_email_opt_in=TRUE AND COALESCE(NULLIF(TRIM(c.email),''),NULLIF(TRIM(u.email),'')) IS NOT NULL AND ${where}`;
}
async function eligible(segmentKey, rawRules = {}) {
    const built = eligibleQuery(segmentKey, rawRules);
    return (await query(`SELECT c.id customer_id,COALESCE(NULLIF(TRIM(c.email),''),NULLIF(TRIM(u.email),'')) email,COALESCE(NULLIF(c.display_name,''),NULLIF(u.username,''),NULLIF(c.email,''),NULLIF(u.email,''),'Customer') display_name ${eligibleIdentitySql(built.where)} ORDER BY c.created_at DESC`, built.params)).rows;
}
async function preview(segmentKey, rawRules = {}) {
    const built = eligibleQuery(segmentKey, rawRules);
    const row = (await query(`SELECT COUNT(*)::int count ${eligibleIdentitySql(built.where)}`, built.params)).rows[0] || { count: 0 };
    return { count: Number(row.count || 0), rules: built.rules };
}
async function currentConsent(customerIds) {
    if (!customerIds.length) return new Set();
    const rows = (await query(`SELECT customer_id FROM customer_communication_preferences WHERE customer_id=ANY($1::uuid[]) AND marketing_email_opt_in=TRUE`, [customerIds])).rows;
    return new Set(rows.map(row => String(row.customer_id)));
}
async function validatePlanExists(planId) {
    if (!planId) return;
    const result = await query(`SELECT id FROM plans WHERE id=$1`, [planId]);
    if (!result.rowCount) throw new Error('The selected plan no longer exists.');
}
async function loadSegment(id) {
    const segmentId = optionalUuid(id, 'saved segment');
    if (!segmentId) return null;
    return (await query(`SELECT * FROM marketing_segments WHERE id=$1`, [segmentId])).rows[0] || null;
}
async function loadTemplate(id) {
    const templateId = optionalUuid(id, 'template');
    if (!templateId) return null;
    return (await query(`SELECT * FROM marketing_templates WHERE id=$1`, [templateId])).rows[0] || null;
}
async function create({ name, subject, bodyText, discountCode, segmentKey, segmentRules = {}, segmentId = null, templateId = null, adminUserId }) {
    const savedSegment = segmentId ? await loadSegment(segmentId) : null;
    if (segmentId && !savedSegment) throw new Error('The selected saved segment no longer exists.');
    const savedTemplate = templateId ? await loadTemplate(templateId) : null;
    if (templateId && !savedTemplate) throw new Error('The selected template no longer exists.');
    const key = segment(savedSegment?.base_segment_key || segmentKey);
    const rules = normalizeRules(savedSegment?.rules || segmentRules);
    await validatePlanExists(rules.planId);
    const campaignName = clean(name, 3, 160, 'Campaign name');
    const mailSubject = clean(String(subject || '').trim() || savedTemplate?.subject, 3, 300, 'Subject');
    const body = clean(String(bodyText || '').trim() || savedTemplate?.body_text, 1, 100000, 'Message');
    const discount = await validateDiscount(discountCode);
    const row = (await query(`INSERT INTO marketing_campaigns(name,subject,body_text,discount_code,segment_key,segment_rules,segment_id,template_id,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`, [campaignName, mailSubject, body, discount, key, JSON.stringify(rules), savedSegment?.id || null, savedTemplate?.id || null, adminUserId])).rows[0];
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.campaign.create','marketing_campaign',$2,$3::jsonb)`, [adminUserId, row.id, JSON.stringify({ segment: key, segmentId: savedSegment?.id || null, templateId: savedTemplate?.id || null, rules, discountCode: discount })]);
    return row;
}
async function list() {
    return (await query(`SELECT c.*,COUNT(r.id)::int snapshotted,COUNT(r.id) FILTER(WHERE r.status='queued')::int recipients_queued,COUNT(r.id) FILTER(WHERE r.status='suppressed')::int recipients_suppressed FROM marketing_campaigns c LEFT JOIN marketing_campaign_recipients r ON r.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC LIMIT 250`)).rows;
}
async function get(id) {
    const campaign = (await query(`SELECT * FROM marketing_campaigns WHERE id=$1`, [id])).rows[0];
    if (!campaign) return null;
    const recipients = (await query(`SELECT * FROM marketing_campaign_recipients WHERE campaign_id=$1 ORDER BY created_at,email_snapshot LIMIT 5000`, [id])).rows;
    return { campaign, recipients };
}
async function snapshotRecipients(campaign) {
    const candidates = await eligible(campaign.segment_key, campaign.segment_rules || {});
    await transaction(async client => {
        for (const person of candidates) {
            await client.query(`INSERT INTO marketing_campaign_recipients(campaign_id,customer_id,email_snapshot,display_name_snapshot) VALUES($1,$2,$3,$4) ON CONFLICT(campaign_id,customer_id) DO NOTHING`, [campaign.id, person.customer_id, person.email, person.display_name]);
        }
        await client.query(`UPDATE marketing_campaigns SET recipient_count=(SELECT COUNT(*) FROM marketing_campaign_recipients WHERE campaign_id=$1),updated_at=NOW() WHERE id=$1`, [campaign.id]);
    });
    return candidates;
}
function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function renderMessage(campaign, recipient, storefrontUrl) {
    const name = recipient.display_name_snapshot || 'there';
    const discount = campaign.discount_code ? `\n\nDiscount code: ${campaign.discount_code}` : '';
    const link = storefrontUrl ? `\n\nView plans: ${storefrontUrl}` : '';
    const footer = 'You are receiving this because you opted in to marketing email in your CAPTAiNFiN account. You can switch marketing email off from your notification preferences.';
    const text = `Hi ${name},\n\n${campaign.body_text}${discount}${link}\n\n${footer}`;
    const html = `<p>Hi ${escapeHtml(name)},</p>${campaign.body_text.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}${campaign.discount_code ? `<p><strong>Discount code: ${escapeHtml(campaign.discount_code)}</strong></p>` : ''}${storefrontUrl ? `<p><a href="${escapeHtml(storefrontUrl)}">View available plans</a></p>` : ''}<p><small>${escapeHtml(footer)}</small></p>`;
    return { text, html };
}
async function sendTest({ to, subject, bodyText, discountCode = '', storefrontUrl = '' }) {
    const campaign = { subject: clean(subject, 3, 300, 'Subject'), body_text: clean(bodyText, 1, 100000, 'Message'), discount_code: await validateDiscount(discountCode) };
    const message = renderMessage(campaign, { display_name_snapshot: 'Marketing preview' }, storefrontUrl);
    return outbox.enqueue({ type: 'marketing_campaign_test', to, subject: `[TEST] ${campaign.subject}`, text: message.text, html: message.html });
}
async function schedule({ campaignId, scheduledFor, adminUserId }) {
    const when = scheduleTime(scheduledFor);
    const result = await query(`UPDATE marketing_campaigns SET status='scheduled',scheduled_for=$2,schedule_next_attempt_at=$2,schedule_attempts=0,schedule_last_error=NULL,updated_at=NOW() WHERE id=$1 AND status IN ('draft','scheduled') RETURNING *`, [campaignId, when]);
    if (!result.rowCount) throw new Error('Only draft or already scheduled campaigns can be scheduled.');
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.campaign.schedule','marketing_campaign',$2,$3::jsonb)`, [adminUserId, campaignId, JSON.stringify({ scheduledFor: when.toISOString() })]);
    return result.rows[0];
}
async function unschedule({ campaignId, adminUserId }) {
    const result = await query(`UPDATE marketing_campaigns SET status='draft',scheduled_for=NULL,schedule_next_attempt_at=NULL,schedule_attempts=0,schedule_last_error=NULL,updated_at=NOW() WHERE id=$1 AND status='scheduled' RETURNING *`, [campaignId]);
    if (!result.rowCount) throw new Error('Only scheduled campaigns can be returned to draft.');
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.campaign.unschedule','marketing_campaign',$2,'{}'::jsonb)`, [adminUserId, campaignId]);
    return result.rows[0];
}
async function queue({ campaignId, adminUserId = null, storefrontUrl = '' }) {
    let data = await get(campaignId);
    if (!data) throw new Error('Campaign not found.');
    if (!['draft', 'scheduled', 'queued'].includes(data.campaign.status)) throw new Error('Only draft, scheduled or partially queued campaigns can be queued.');
    const currentEligibleRows = await snapshotRecipients(data.campaign);
    data = await get(campaignId);
    if (!data.recipients.length) throw new Error('No eligible opted-in recipients are available for this campaign.');

    const pending = data.recipients.filter(recipient => recipient.status !== 'queued' && recipient.status !== 'suppressed');
    const eligibleIds = new Set(currentEligibleRows.map(row => String(row.customer_id)));
    const consented = await currentConsent(pending.map(row => row.customer_id));
    let queued = 0;
    let suppressed = 0;
    for (const recipient of pending) {
        const customerId = String(recipient.customer_id);
        let reason = null;
        if (!consented.has(customerId)) reason = 'opted_out_before_send';
        else if (!eligibleIds.has(customerId)) reason = 'no_longer_eligible';
        if (reason) {
            await query(`UPDATE marketing_campaign_recipients SET status='suppressed',suppression_reason=$2,updated_at=NOW() WHERE id=$1`, [recipient.id, reason]);
            suppressed += 1;
            continue;
        }
        const message = renderMessage(data.campaign, recipient, storefrontUrl);
        const item = await outbox.enqueue({ type: 'marketing_campaign', to: recipient.email_snapshot, subject: data.campaign.subject, text: message.text, html: message.html, dedupeKey: `marketing:${data.campaign.id}:${recipient.customer_id}` });
        await query(`UPDATE marketing_campaign_recipients SET status='queued',outbox_id=$2,updated_at=NOW() WHERE id=$1`, [recipient.id, item.id]);
        queued += 1;
    }
    await query(`UPDATE marketing_campaigns SET status='queued',queued_count=(SELECT COUNT(*) FROM marketing_campaign_recipients WHERE campaign_id=$1 AND status='queued'),queued_at=COALESCE(queued_at,NOW()),schedule_next_attempt_at=NULL,schedule_last_error=NULL,updated_at=NOW() WHERE id=$1`, [campaignId]);
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.campaign.queue','marketing_campaign',$2,$3::jsonb)`, [adminUserId, campaignId, JSON.stringify({ queuedNow: queued, suppressedNow: suppressed, scheduled: Boolean(data.campaign.scheduled_for) })]);
    return { queued, suppressed };
}
async function due(limit = 20) {
    return (await query(`SELECT id FROM marketing_campaigns WHERE status='scheduled' AND COALESCE(schedule_next_attempt_at,scheduled_for)<=NOW() ORDER BY COALESCE(schedule_next_attempt_at,scheduled_for),id LIMIT $1`, [Math.max(1, Math.min(100, Number(limit) || 20))])).rows;
}
async function runDue({ limit = 20, storefrontUrl = '' } = {}) {
    const rows = await due(limit);
    const result = { total: rows.length, processed: 0, failed: 0 };
    for (const row of rows) {
        try {
            await queue({ campaignId: row.id, adminUserId: null, storefrontUrl });
            result.processed += 1;
        } catch (error) {
            result.failed += 1;
            await query(`UPDATE marketing_campaigns SET schedule_attempts=schedule_attempts+1,schedule_next_attempt_at=NOW()+INTERVAL '5 minutes',schedule_last_error=$2,updated_at=NOW() WHERE id=$1 AND status='scheduled'`, [row.id, String(error?.message || error).slice(0, 1500)]);
        }
    }
    return result;
}
async function listSegments({ withCounts = false } = {}) {
    const rows = (await query(`SELECT * FROM marketing_segments ORDER BY updated_at DESC,name`)).rows;
    if (!withCounts) return rows;
    return Promise.all(rows.map(async row => ({ ...row, current_count: (await preview(row.base_segment_key, row.rules || {})).count })));
}
async function saveSegment({ id = null, name, baseSegmentKey, rules = {}, adminUserId }) {
    const segmentName = clean(name, 3, 160, 'Segment name');
    const key = segment(baseSegmentKey);
    const normalized = normalizeRules(rules);
    await validatePlanExists(normalized.planId);
    let row;
    if (id) {
        const segmentId = optionalUuid(id, 'segment');
        const result = await query(`UPDATE marketing_segments SET name=$2,base_segment_key=$3,rules=$4::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`, [segmentId, segmentName, key, JSON.stringify(normalized)]);
        if (!result.rowCount) throw new Error('Saved segment not found.');
        row = result.rows[0];
    } else {
        row = (await query(`INSERT INTO marketing_segments(name,base_segment_key,rules,created_by_user_id) VALUES($1,$2,$3::jsonb,$4) RETURNING *`, [segmentName, key, JSON.stringify(normalized), adminUserId])).rows[0];
    }
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'marketing_segment',$3,$4::jsonb)`, [adminUserId, id ? 'marketing.segment.update' : 'marketing.segment.create', row.id, JSON.stringify({ baseSegmentKey: key, rules: normalized })]);
    return row;
}
async function deleteSegment({ id, adminUserId }) {
    const segmentId = optionalUuid(id, 'segment');
    const result = await query(`DELETE FROM marketing_segments WHERE id=$1 RETURNING id,name`, [segmentId]);
    if (!result.rowCount) throw new Error('Saved segment not found.');
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.segment.delete','marketing_segment',$2,$3::jsonb)`, [adminUserId, segmentId, JSON.stringify({ name: result.rows[0].name })]);
    return result.rows[0];
}
async function listTemplates() {
    return (await query(`SELECT * FROM marketing_templates ORDER BY updated_at DESC,name`)).rows;
}
async function saveTemplate({ id = null, name, subject, bodyText, adminUserId }) {
    const templateName = clean(name, 3, 160, 'Template name');
    const templateSubject = clean(subject, 3, 300, 'Template subject');
    const templateBody = clean(bodyText, 1, 100000, 'Template message');
    let row;
    if (id) {
        const templateId = optionalUuid(id, 'template');
        const result = await query(`UPDATE marketing_templates SET name=$2,subject=$3,body_text=$4,updated_at=NOW() WHERE id=$1 RETURNING *`, [templateId, templateName, templateSubject, templateBody]);
        if (!result.rowCount) throw new Error('Template not found.');
        row = result.rows[0];
    } else {
        row = (await query(`INSERT INTO marketing_templates(name,subject,body_text,created_by_user_id) VALUES($1,$2,$3,$4) RETURNING *`, [templateName, templateSubject, templateBody, adminUserId])).rows[0];
    }
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'marketing_template',$3,$4::jsonb)`, [adminUserId, id ? 'marketing.template.update' : 'marketing.template.create', row.id, JSON.stringify({ name: templateName })]);
    return row;
}
async function deleteTemplate({ id, adminUserId }) {
    const templateId = optionalUuid(id, 'template');
    const result = await query(`DELETE FROM marketing_templates WHERE id=$1 RETURNING id,name`, [templateId]);
    if (!result.rowCount) throw new Error('Template not found.');
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.template.delete','marketing_template',$2,$3::jsonb)`, [adminUserId, templateId, JSON.stringify({ name: result.rows[0].name })]);
    return result.rows[0];
}
async function overview() {
    const [audience, campaigns, delivery] = await Promise.all([
        query(`SELECT COUNT(*)::int opted_in FROM customer_communication_preferences cp JOIN customers c ON c.id=cp.customer_id LEFT JOIN app_users u ON u.id=c.user_id WHERE cp.marketing_email_opt_in=TRUE AND COALESCE(NULLIF(TRIM(c.email),''),NULLIF(TRIM(u.email),'')) IS NOT NULL`),
        query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='scheduled')::int scheduled,COUNT(*) FILTER(WHERE status='draft')::int drafts FROM marketing_campaigns`),
        query(`SELECT COUNT(*) FILTER(WHERE status='pending')::int pending,COUNT(*) FILTER(WHERE status='failed')::int failed,COUNT(*) FILTER(WHERE status='sent')::int sent FROM notification_outbox WHERE message_type='marketing_campaign'`)
    ]);
    return { ...(audience.rows[0] || {}), ...(campaigns.rows[0] || {}), ...(delivery.rows[0] || {}) };
}

module.exports = {
    SEGMENTS, SERVICES, PRICE_TYPES, SUBSCRIPTION_STATUSES, BILLING_INTERVALS,
    segment, normalizeRules, eligibleQuery, eligible, preview, create, list, get,
    queue, schedule, unschedule, due, runDue, validateDiscount, renderMessage,
    scheduleTime, sendTest, listSegments, saveSegment, deleteSegment, loadSegment,
    listTemplates, saveTemplate, deleteTemplate, loadTemplate, overview
};
