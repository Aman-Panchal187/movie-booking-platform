import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/shared/database/migrations', { recursive: true });
cpSync('src/shared/database/migrations', 'dist/shared/database/migrations', { recursive: true });
