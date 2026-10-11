import { Sequelize } from 'sequelize';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/mbp_test';

/** Recreates the schema from the real versioned migrations on a real PostgreSQL database. */
export default async function setup(): Promise<void> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret';
  process.env.LOG_LEVEL = 'silent';
  const { runMigrations } = await import('../src/shared/database/migrate.js');
  const db = new Sequelize(TEST_DATABASE_URL, { dialect: 'postgres', logging: false });
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(db);
  await db.close();
}
