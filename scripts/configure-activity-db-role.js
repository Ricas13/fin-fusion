'use strict';

const { main } = require('./configure-runtime-db-roles');

main({ activityOnly: true }).catch(error => {
    console.error(error.message);
    process.exit(1);
});
