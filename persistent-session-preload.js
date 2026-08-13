'use strict';

require('dotenv').config();

if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_URL is required in production for persistent sessions');
    }
    return;
}

const sessionPath = require.resolve('express-session');
const realSession = require(sessionPath);
const PgStore = require('connect-pg-simple')(realSession);

function persistentSession(options = {}) {
    const merged = {
        ...options,
        store: options.store || new PgStore({
            conString: process.env.DATABASE_URL,
            createTableIfMissing: true,
            tableName: 'user_sessions',
            pruneSessionInterval: 60 * 15
        })
    };
    return realSession(merged);
}

Object.assign(persistentSession, realSession);
require.cache[sessionPath].exports = persistentSession;
