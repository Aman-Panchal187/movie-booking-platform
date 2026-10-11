import { sequelize } from '../shared/database/sequelize';
import { runMigrations } from '../shared/database/migrate';
import { logger } from '../shared/logging/logger';

runMigrations(sequelize)
  .then((applied) => {
    logger.info({ applied }, 'migrations complete');
    return sequelize.close();
  })
  .catch((err) => {
    logger.error({ err }, 'migration failed');
    process.exit(1);
  });
