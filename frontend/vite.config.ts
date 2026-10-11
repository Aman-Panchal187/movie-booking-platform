import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000', '/api-docs': process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'], css: false },
});
