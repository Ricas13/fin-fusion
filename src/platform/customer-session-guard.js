'use strict';

function requireCustomer(req, res, next) {
    if (req.session?.customerId && req.session?.customerUserId) return next();
    return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl || '/account'));
}

module.exports = { requireCustomer };
