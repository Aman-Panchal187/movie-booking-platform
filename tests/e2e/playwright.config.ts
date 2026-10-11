import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const root = path.resolve(__dirname, '../..');
const DB = 'postgres://postgres:postgres@localhost:55432/mbp_e2e';
const API_PORT = 3100;
const WEB_PORT = 5174;

export default defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.ts',
  globalSetup: path.join(__dirname, 'global-setup.ts'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx src/server.ts',
      cwd: path.join(root, 'backend'),
      url: `http://localhost:${API_PORT}/health/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { DATABASE_URL: DB, JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret', PORT: String(API_PORT), LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4', NODE_ENV: 'development' },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: path.join(root, 'frontend'),
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_PROXY_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
