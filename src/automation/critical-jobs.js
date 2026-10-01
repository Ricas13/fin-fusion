'use strict';

const metadata = require('./job-metadata');

// Compatibility facade for existing operator/deployment callers. The canonical
// critical/disableable flags now live with the rest of each job's metadata.
const CUSTOMER_ACCESS_CRITICAL_JOBS = Object.freeze(metadata.criticalNames());
const DISABLEABLE_CRITICAL_JOBS = Object.freeze(metadata.disableableCriticalNames());

function names() {
    return [...CUSTOMER_ACCESS_CRITICAL_JOBS];
}

function isCritical(jobKey) {
    return Boolean(metadata.get(jobKey)?.critical);
}

function mayBeDisabled(jobKey) {
    return Boolean(metadata.get(jobKey)?.disableableCritical);
}

module.exports = {
    CUSTOMER_ACCESS_CRITICAL_JOBS,
    DISABLEABLE_CRITICAL_JOBS,
    names,
    isCritical,
    mayBeDisabled
};
