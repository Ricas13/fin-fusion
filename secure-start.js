'use strict';

// Compatibility entry point retained for older deployment commands. Security,
// sessions, routing and runtime validation are now normal application modules
// rather than monkey-patches applied before loading a legacy JSON application.
const { start } = require('./src/application');
start();
