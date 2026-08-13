'use strict';

const auth = require('./service');

function destroy(req) {
    return new Promise(resolve => {
        if (!req.session) return resolve();
        req.session.destroy(() => resolve());
    });
}

async function guardSession(req, res, next) {
    try {
        // Legacy staff sessions are intentionally invalidated on rollout. Customers
        // use separate customerUserId/customerId fields and are unaffected.
        if ((req.session?.adminId || req.session?.resellerId) && !req.session?.authUserId) {
            delete req.session.adminId;
            delete req.session.resellerId;
            delete req.session.userType;
            return next();
        }

        if (!req.session?.authUserId || !['admin', 'reseller'].includes(req.session?.authRole)) {
            return next();
        }

        const result = await auth.validateStaffSession(req);
        if (result.valid) return next();

        await destroy(req);
        if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, error: 'Session expired' });
        return res.redirect('/login?session=expired');
    } catch (error) {
        console.error('Staff session validation failed:', error.message);
        if (process.env.NODE_ENV === 'production' && req.session?.authUserId) {
            await destroy(req);
            return res.status(503).send('Authentication service unavailable');
        }
        return next(error);
    }
}

module.exports = { guardSession };
