'use strict';
const express = require('express');
const { storefrontPage } = require('./src/platform/storefront');
const currentGet = express.application.get;
express.application.get = function storefrontGet(path, ...handlers) {
    if (path === '/' && handlers.length) return currentGet.call(this, path, storefrontPage);
    return currentGet.call(this, path, ...handlers);
};
