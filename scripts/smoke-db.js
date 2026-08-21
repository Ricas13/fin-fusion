'use strict';

require('dotenv').config();

function skipIfNoDatabase(label) {
    if (String(process.env.DATABASE_URL || '').trim()) return false;
    console.log(`${label}: skipped (DATABASE_URL not set).`);
    return true;
}

module.exports = { skipIfNoDatabase };
