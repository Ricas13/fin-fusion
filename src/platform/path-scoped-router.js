'use strict';

function onlyPathPrefix(prefix, childRouter) {
    const normalized = String(prefix || '').replace(/\/$/, '');
    return function pathScopedRouter(req, res, next) {
        const requestPath = req.path || '';
        if (requestPath !== normalized && !requestPath.startsWith(normalized + '/')) return next();
        return childRouter(req, res, next);
    };
}

module.exports = { onlyPathPrefix };
