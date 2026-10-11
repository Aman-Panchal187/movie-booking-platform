import { sequelize } from '../shared/database/sequelize';
import { createAdminAccount } from '../modules/auth/authService';
import { logger } from '../shared/logging/logger';

/**
 * One-time admin bootstrap. Credentials come from the environment at run time and are never stored in
 * the repository:  ADMIN_EMAIL=... ADMIN_NAME=... ADMIN_PASSWORD=... npm run admin:create
 */
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME ?? 'Platform Admin';
  if (!email || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  const id = await createAdminAccount({ name, email, password });
  logger.info(id ? { email } : { email, skipped: true }, id ? 'admin created' : 'admin already exists; nothing changed');
  await sequelize.close();
}

main().catch((err) => {
  logger.error({ err }, 'admin bootstrap failed');
  process.exit(1);
});
