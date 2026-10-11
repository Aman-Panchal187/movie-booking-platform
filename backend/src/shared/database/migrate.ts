import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Sequelize } from 'sequelize';
import { moduleLogger } from '../logging/logger';

const log = moduleLogger('migrations');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// Arbitrary constant so concurrent deploys serialize on one advisory lock.
const MIGRATION_LOCK_ID = 727274;

/** Applies pending versioned SQL migrations in filename order. Safe to run repeatedly. */
export async function runMigrations(db: Sequelize): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];

  await db.transaction(async (transaction) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', { bind: [MIGRATION_LOCK_ID], transaction });
    await db.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      { transaction },
    );
    const [rows] = await db.query('SELECT version FROM schema_migrations', { transaction });
    const done = new Set((rows as { version: string }[]).map((r) => r.version));

    for (const file of files) {
      if (done.has(file)) continue;
      await db.query(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'), { transaction });
      await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', {
        bind: [file],
        transaction,
      });
      applied.push(file);
      log.info({ migration: file }, 'migration applied');
    }
  });
  return applied;
}
