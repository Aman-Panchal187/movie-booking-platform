import { execSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';

const DB = 'postgres://postgres:postgres@localhost:55432/mbp_e2e';

/** Fresh schema + migrations + demo seed (local-only accounts) before every E2E run. */
export default async function globalSetup(): Promise<void> {
  const client = new Client({ connectionString: DB });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  const env = {
    ...process.env,
    DATABASE_URL: DB,
    JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret',
    DEMO_PASSWORD: 'E2e-Demo-Pass-1',
    LOG_LEVEL: 'warn',
    NODE_ENV: 'development',
    BCRYPT_ROUNDS: '4',
  };
  const cwd = path.resolve(__dirname, '../../backend');
  execSync('npx tsx src/scripts/migrate.ts', { cwd, env, stdio: 'inherit' });
  execSync('npx tsx src/scripts/seed.ts', { cwd, env, stdio: 'inherit' });
}
