'use strict';

const pkg = require('../package.json');

const version = String(pkg.version || '0.0.0');
const gitSha = String(
  process.env.CAPTAINFIN_BUILD_SHA
  || process.env.GITHUB_SHA
  || process.env.SOURCE_COMMIT
  || ''
).trim() || null;

function providerAppInfo() {
  return { name: 'CAPTAiNFiN', version };
}

function snapshot() {
  return {
    product: 'CAPTAiNFiN',
    version,
    gitSha
  };
}

module.exports = { version, gitSha, providerAppInfo, snapshot };
