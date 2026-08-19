'use strict';

// Compatibility path for older callers. The historical module name is now the
// canonical implementation so workers, admin routes and customer routes have
// one obvious owner.
module.exports = require('./request-user-sync');
