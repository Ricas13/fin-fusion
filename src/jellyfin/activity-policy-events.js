'use strict';

const SAFETY_ATTENTION_REASONS = Object.freeze([
    'incomplete_server_snapshot',
    'revalidation_failed',
    'client_does_not_report_media_control_support'
]);

const REASON_LABELS = Object.freeze({
    grace_period: 'Grace period still running',
    confirmation_threshold: 'Waiting for confirmation threshold',
    incomplete_server_snapshot: 'Server snapshot incomplete',
    enforcement_ack_missing: 'Enforcement acknowledgement missing',
    observe_only: 'Observe / warn mode only',
    revalidation_failed: 'Live session revalidation failed',
    violation_cleared_before_action: 'Limit violation cleared before action',
    candidate_changed_before_action: 'Playback changed before action',
    client_does_not_report_media_control_support: 'Client cannot confirm media-control support',
    confirmed_concurrent_stream_limit: 'Confirmed concurrent stream limit',
    jellyfin_stop_failed: 'Jellyfin stop request failed',
    jellyfin_stop_did_not_end_session: 'Jellyfin client ignored the stop request',
    jellyfin_force_logout_failed: 'Jellyfin device logout failed',
    post_stop_revalidation_failed: 'Could not verify that playback stopped'
});

const DECISION_LABELS = Object.freeze({
    would_stop: 'Would stop',
    stopped: 'Stopped playback',
    stop_failed: 'Stop failed',
    skipped_safety: 'Safety skip',
    pending: 'Pending confirmation'
});

function safetyAttention(reason) {
    return SAFETY_ATTENTION_REASONS.includes(String(reason || ''));
}

function reasonLabel(value) {
    const key = String(value || '');
    return REASON_LABELS[key] || key.replaceAll('_', ' ') || 'Policy decision';
}

function decisionLabel(value) {
    const key = String(value || '');
    return DECISION_LABELS[key] || key.replaceAll('_', ' ') || 'Policy event';
}

module.exports = {
    SAFETY_ATTENTION_REASONS,
    REASON_LABELS,
    DECISION_LABELS,
    safetyAttention,
    reasonLabel,
    decisionLabel
};