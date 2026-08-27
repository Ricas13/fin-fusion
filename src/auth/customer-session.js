'use strict';

const crypto = require('crypto');
const customers = require('../customers');

function regenerate(req) {
    return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
}

function save(req) {
    return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

function destroy(req) {
    return new Promise(resolve => req.session ? req.session.destroy(() => resolve()) : resolve());
}

function normalizeAccount(account) {
    const user = account?.user || null;
    const customer = account?.customer || null;
    const userId = account?.userId || user?.id || null;
    const customerId = account?.customerId || customer?.id || null;
    const username = account?.username || user?.username || null;
    const sessionVersion = Number(account?.sessionVersion || user?.session_version || 1);
    if (!userId || !customerId || !username) throw new Error('Customer session identity is incomplete.');
    return { userId, customerId, username, sessionVersion };
}

async function establish(req, account) {
    const identity = normalizeAccount(account);
    await regenerate(req);
    req.session.customerUserId = identity.userId;
    req.session.customerId = identity.customerId;
    req.session.customerUsername = identity.username;
    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
    await customers.registerCustomerSession(req, identity);
    await save(req);
    return identity;
}

module.exports = { establish, regenerate, save, destroy, normalizeAccount };
