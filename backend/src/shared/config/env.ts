import { z } from 'zod';

const boolString = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_SSL: boolString,
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  FRONTEND_URL: z.string().optional(),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  REDIS_URL: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  METRICS_TOKEN: z.string().optional(),
  HOLD_DURATION_SECONDS: z.coerce.number().int().positive().default(300),
  MAX_SEATS_PER_BOOKING: z.coerce.number().int().positive().default(8),
  // Load-testing aid only: multiplies rate limits x1000. Ignored when NODE_ENV=production.
  RELAX_RATE_LIMITS: boolString,
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(14).default(10),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

export function corsOrigins(e: Env): string[] {
  const list = e.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (e.FRONTEND_URL) list.push(e.FRONTEND_URL.trim());
  return [...new Set(list)];
}
