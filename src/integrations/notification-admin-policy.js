'use strict';

const GROUP_ORDER = Object.freeze(['Money', 'Access', 'Growth', 'Noise']);

function group(eventType) {
    const value = String(eventType || '').trim().toLowerCase();
    if (/^(login|session)\./.test(value)) return 'Noise';
    if (/^payment\./.test(value) || /^subscription\.plan_change\./.test(value)) return 'Money';
    if (/^customer\.(registered|trial\.started|claim\.completed)$/.test(value) || /^(request|affiliate)\./.test(value)) return 'Growth';
    return 'Access';
}

function defaultEnabled(eventType) {
    const bucket = group(eventType);
    return bucket === 'Money' || bucket === 'Access';
}

module.exports = { GROUP_ORDER, group, defaultEnabled };
