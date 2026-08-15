'use strict';

const express = require('express');
const storefront = require('./storefront');

// Compatibility shim while platform-preload is progressively simplified.
// Reseller tiers are now rendered directly by the canonical storefront module,
// so this router intentionally registers no routes and cannot compete for GET /.
function createResellerStorefrontRouter() {
    return express.Router();
}

module.exports = {
    createResellerStorefrontRouter,
    resellerSection: storefront.resellerSection
};
