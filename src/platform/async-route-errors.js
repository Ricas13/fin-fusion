'use strict';

// Express 4 does not observe the promise returned by an async route handler or
// middleware. A rejection that escapes the handler's own try/catch therefore
// never reaches the error middleware: the request hangs and, because Node exits
// on unhandled rejections, the whole web process terminates. This installs the
// same small Layer patch used by express-async-errors so rejected handler
// promises are forwarded to next(error) like synchronous throws already are.

const INSTALLED = Symbol.for('captainfin.asyncRouteErrors.installed');

function isThenable(value) {
  return Boolean(value) && typeof value.then === 'function';
}

function install() {
  let Layer;
  try {
    Layer = require('express/lib/router/layer');
  } catch (error) {
    console.warn('Async route error forwarding unavailable:', error.message);
    return false;
  }
  if (Layer.prototype[INSTALLED]) return false;

  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const result = fn(req, res, next);
      if (isThenable(result)) result.then(undefined, next);
    } catch (error) {
      next(error);
    }
  };

  Layer.prototype.handle_error = function handleError(error, req, res, next) {
    const fn = this.handle;
    if (fn.length !== 4) return next(error);
    try {
      const result = fn(error, req, res, next);
      if (isThenable(result)) result.then(undefined, next);
    } catch (nextError) {
      next(nextError);
    }
  };

  Object.defineProperty(Layer.prototype, INSTALLED, { value: true });
  return true;
}

module.exports = { install };
