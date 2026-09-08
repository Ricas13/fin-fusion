'use strict';

const readiness = require('./free-claim-readiness');

module.exports = {
  ...readiness,
  ensureFreeClaimProvisioned: readiness.ensureFreeClaimReady
};
