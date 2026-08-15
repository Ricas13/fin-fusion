'use strict';

// Compatibility entry point for operators/scripts that historically invoked
// `node app.js`.  All runtime composition now lives in src/application.js.
const { start } = require('./src/application');
start();
