'use strict';

function postgresProcessEnv(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !url.username || !dbName) {
    throw new Error('DATABASE_URL must include host, user and database');
  }
  const env = { ...process.env };
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || '5432';
  env.PGUSER = decodeURIComponent(url.username);
  env.PGDATABASE = dbName;
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);

  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) env.PGSSLMODE = sslMode;
  else if (String(process.env.DB_SSL).toLowerCase() === 'true') {
    env.PGSSLMODE = String(process.env.DB_SSL_REJECT_UNAUTHORIZED).toLowerCase() === 'false' ? 'require' : 'verify-full';
  }
  return env;
}

module.exports = { postgresProcessEnv };
