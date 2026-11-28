'use strict';

// Longest legitimate run, in seconds, for jobs that can outlast the default
// stuck threshold. Kept dependency-free so job health can read it without
// loading the executable job registry, which publishes it as job metadata.
module.exports = Object.freeze({
    stremio_media_index: 3600
});
