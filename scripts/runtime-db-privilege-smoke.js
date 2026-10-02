'use strict';

const runtimePrivileges = require('./runtime-db-privileges');

if (require.main === module) {
  runtimePrivileges.main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = runtimePrivileges;
