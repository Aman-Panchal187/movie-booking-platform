import { startTracing, stopTracing } from './shared/observability/tracing';

// Tracing must start before express/pg are loaded so they can be instrumented.
startTracing();

import http from 'node:http';
import { createApp } from './app';
import { env } from './shared/config/env';
import { sequelize } from './shared/database/sequelize';
import { runMigrations } from './shared/database/migrate';
import { logger } from './shared/logging/logger';

async function main(): Promise<void> {
  const e = env();
  await sequelize.authenticate();
  if (process.env.RUN_MIGRATIONS_ON_START === 'true') await runMigrations(sequelize);

  const { app, cacheClient } = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
  server.listen(e.PORT, e.HOST, () => logger.info({ port: e.PORT, host: e.HOST, cache: cacheClient.kind }, 'api listening'));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(async () => {
      await Promise.allSettled([sequelize.close(), cacheClient.close(), stopTracing()]);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'unhandled promise rejection');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
