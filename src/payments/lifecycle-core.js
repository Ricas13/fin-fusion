'use strict';

// Historical import path. The canonical lifecycle implementation now lives in
// lifecycle.js so capacity, audience, Stremio capability, free/trial policy and
// provider activation rules cannot diverge across two public modules.
module.exports = require('./lifecycle');
