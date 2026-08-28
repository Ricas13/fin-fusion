'use strict';

const { query } = require('../db');
const customerFilters = require('../platform/customer-filters');

function clean(value, min, max, label) {
    const text = String(value || '').trim();
    if (text.length < min || text.length > max) throw new Error(`${label} must be between ${min} and ${max} characters.`);
    return text;
}

function optionalInt(value, min, max, label) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== String(value).trim() || parsed < min || parsed > max) {
        throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
    }
    return parsed;
}

function optionalEnum(value, allowed, label) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return null;
    if (!allowed.includes(text)) throw new Error(`Choose a valid ${label}.`);
    return text;
}

function optionalUuid(value, label) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (!customerFilters.isUuid(text)) throw new Error(`Choose a valid ${label}.`);
    return text;
}

function normalizeFilters(input = {}) {
    const filters = {};
    const service = optionalEnum(input.service, customerFilters.SERVICE_VALUES, 'service');
    const statusValues = [...customerFilters.STATUS_VALUES, 'none'];
    const status = optionalEnum(input.status, statusValues, 'subscription status');
    const priceType = optionalEnum(input.priceType, customerFilters.PRICE_TYPES, 'price type');
    const billingInterval = optionalEnum(input.billingInterval, customerFilters.BILLING_INTERVALS, 'billing interval');
    const planId = optionalUuid(input.planId, 'plan');
    const accountAgeDays = optionalInt(input.accountAgeDays, 0, 3650, 'Account age');
    const lapsedDays = optionalInt(input.lapsedDays, 0, 3650, 'Lapsed time');
    const expiresWithinDays = optionalInt(input.expiresWithinDays, 1, 365, 'Expiry window');
    const inactivePlaybackDays = optionalInt(input.inactivePlaybackDays, 1, 3650, 'Playback inactivity');

    if (service) filters.service = service;
    if (status) filters.status = status;
    if (priceType) filters.priceType = priceType;
    else if (input.isFreeTier === true || String(input.isFreeTier || '') === '1') filters.priceType = 'free';
    if (billingInterval) filters.billingInterval = billingInterval;
    if (planId) filters.planId = planId;
    if (accountAgeDays !== null) filters.accountAgeDays = accountAgeDays;
    if (lapsedDays !== null) filters.lapsedDays = lapsedDays;
    if (expiresWithinDays !== null) filters.expiresWithinDays = expiresWithinDays;
    if (inactivePlaybackDays !== null) filters.inactivePlaybackDays = inactivePlaybackDays;
    return filters;
}

async function validatePlan(filters) {
    if (!filters.planId) return;
    const result = await query(`SELECT id FROM plans WHERE id=$1 AND archived_at IS NULL`, [filters.planId]);
    if (!result.rowCount) throw new Error('The selected plan is no longer available.');
}

async function list() {
    return (await query(`SELECT id,name,audience_filters,created_by_user_id,created_at,updated_at FROM marketing_segments ORDER BY updated_at DESC,name LIMIT 200`)).rows;
}

async function get(id) {
    const segmentId = optionalUuid(id, 'saved segment');
    if (!segmentId) return null;
    return (await query(`SELECT id,name,audience_filters,created_by_user_id,created_at,updated_at FROM marketing_segments WHERE id=$1`, [segmentId])).rows[0] || null;
}

async function save({ id = null, name, audienceFilters = {}, adminUserId = null }) {
    const segmentId = optionalUuid(id, 'saved segment');
    const segmentName = clean(name, 3, 160, 'Segment name');
    const filters = normalizeFilters(audienceFilters);
    await validatePlan(filters);
    const duplicate = (await query(`SELECT id FROM marketing_segments WHERE LOWER(name)=LOWER($1) AND ($2::uuid IS NULL OR id<>$2::uuid) LIMIT 1`, [segmentName, segmentId])).rows[0];
    if (duplicate) throw new Error('A saved segment with that name already exists.');

    let row;
    if (segmentId) {
        const result = await query(`UPDATE marketing_segments SET name=$2,audience_filters=$3::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`, [segmentId, segmentName, JSON.stringify(filters)]);
        if (!result.rowCount) throw new Error('Saved segment not found.');
        row = result.rows[0];
    } else {
        row = (await query(`INSERT INTO marketing_segments(name,audience_filters,created_by_user_id) VALUES($1,$2::jsonb,$3) RETURNING *`, [segmentName, JSON.stringify(filters), adminUserId])).rows[0];
    }

    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'marketing_segment',$3,$4::jsonb)`, [
        adminUserId,
        segmentId ? 'marketing.segment.update' : 'marketing.segment.create',
        row.id,
        JSON.stringify({ name: row.name, audienceFilters: filters })
    ]);
    return row;
}

async function remove({ id, adminUserId = null }) {
    const segmentId = optionalUuid(id, 'saved segment');
    if (!segmentId) throw new Error('Saved segment not found.');
    const result = await query(`DELETE FROM marketing_segments WHERE id=$1 RETURNING id,name`, [segmentId]);
    if (!result.rowCount) throw new Error('Saved segment not found.');
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.segment.delete','marketing_segment',$2,$3::jsonb)`, [adminUserId, segmentId, JSON.stringify({ name: result.rows[0].name })]);
    return result.rows[0];
}

module.exports = { clean, optionalInt, optionalEnum, optionalUuid, normalizeFilters, validatePlan, list, get, save, remove };
