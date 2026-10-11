import { timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express, { Express, RequestHandler } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { CacheClient, createCacheClient } from './shared/cache/clients';
import { CacheService } from './shared/cache/cacheService';
import { Env, corsOrigins, env } from './shared/config/env';
import { checkDatabase } from './shared/database/sequelize';
import { errorHandler, notFoundHandler } from './shared/errors/errorHandler';
import { AppError } from './shared/errors/errors';
import { makeLimiter } from './shared/middleware/rateLimit';
import { metricsMiddleware, requestId, requestLogger } from './shared/middleware/requestContext';
import { dbFailures, registry } from './shared/observability/metrics';
import { adminRoutes } from './modules/admin/adminRoutes';
import { authRoutes } from './modules/auth/authRoutes';
import { BookingService } from './modules/bookings/bookingService';
import { bookingRoutes, ticketRoutes } from './modules/bookings/bookingRoutes';
import { MediaService } from './modules/media/mediaService';
import { MovieService } from './modules/movies/movieService';
import { movieRoutes } from './modules/movies/movieRoutes';
import { PaymentService } from './modules/payments/paymentService';
import { paymentRoutes } from './modules/payments/paymentRoutes';
import { adminReportRoutes, managerReportRoutes } from './modules/reports/reportRoutes';
import { ReportService } from './modules/reports/reportService';
import { ShowService } from './modules/shows/showService';
import { TheatreApprovalService } from './modules/theatre-approvals/theatreApprovalService';
import { TheatreService } from './modules/theatres/theatreService';
import { managerRoutes, showRoutes, theatreRoutes } from './modules/theatres/theatreRoutes';
import { openApiSpec } from './openapi/spec';

export interface RateLimits {
  read: number;
  login: number;
  loginPerEmail: number;
  register: number;
  hold: number;
  payment: number;
  admin: number;
  upload: number;
  submit: number;
}

export const DEFAULT_LIMITS: RateLimits = {
  read: 100,
  login: 5,
  loginPerEmail: 10,
  register: 5,
  hold: 10,
  payment: 5,
  admin: 60,
  upload: 10,
  submit: 10,
};

export interface AppOptions {
  env?: Env;
  cacheClient?: CacheClient;
  limits?: Partial<RateLimits>;
}

export interface AppHandle {
  app: Express;
  cache: CacheService;
  cacheClient: CacheClient;
}

const MINUTE = 60_000;

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function metricsGuard(e: Env): RequestHandler {
  return (req, _res, next) => {
    // In production /metrics is only reachable with a bearer token (and Nginx does not proxy it publicly).
    if (e.NODE_ENV === 'production' && !e.METRICS_TOKEN) return next(new AppError(404, 'NOT_FOUND', 'Route not found'));
    if (e.METRICS_TOKEN && !sameSecret(req.header('authorization') ?? '', `Bearer ${e.METRICS_TOKEN}`)) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Metrics token required'));
    }
    next();
  };
}

export function createApp(options: AppOptions = {}): AppHandle {
  const e = options.env ?? env();
  const relax = e.RELAX_RATE_LIMITS && e.NODE_ENV !== 'production' ? 1000 : 1;
  const base = { ...DEFAULT_LIMITS, ...options.limits };
  const limits = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v * relax])) as unknown as RateLimits;
  const cacheClient = options.cacheClient ?? createCacheClient(e);
  const cache = new CacheService(cacheClient);

  const movies = new MovieService(cache);
  const theatres = new TheatreService(cache);
  const shows = new ShowService(cache);
  const bookings = new BookingService();
  const payments = new PaymentService(cache);
  const reports = new ReportService(cache);
  const theatreApprovals = new TheatreApprovalService(cache);
  const media = new MediaService(e);

  const app = express();
  app.disable('x-powered-by');
  // Nginx is the single trusted hop; it overwrites X-Forwarded-For with the real client address.
  app.set('trust proxy', e.TRUST_PROXY);

  app.use(requestId);
  app.use(requestLogger);
  app.use(metricsMiddleware);
  app.use(helmet());
  const origins = corsOrigins(e);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  // ---- Operational endpoints (outside /api)
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    const dbOk = await checkDatabase();
    if (!dbOk) dbFailures.inc();
    const cacheOk = await cache.healthy();
    const body = {
      status: dbOk ? (cacheOk ? 'ok' : 'degraded') : 'unavailable',
      dependencies: {
        postgres: dbOk ? 'up' : 'down',
        cache: cacheOk ? `up (${cache.backend})` : 'degraded',
        cloudinary: media.isConfigured ? 'configured' : 'not-configured',
      },
    };
    res.status(dbOk ? 200 : 503).json(body);
  });
  app.get('/metrics', metricsGuard(e), async (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });
  app.get('/api-docs/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: 'Movie Booking API' }));

  // ---- Rate limiters
  const lim = (name: string, max: number, windowMs: number, keyBy: 'ip' | 'user' = 'ip') =>
    makeLimiter(cacheClient, { name, max, windowMs, keyBy });
  const emailKey = (req: express.Request) => `email:${String((req.body as { email?: unknown })?.email ?? '').toLowerCase()}`;

  const api = express.Router();
  api.use(lim('read', limits.read, MINUTE));

  api.use(
    '/auth',
    authRoutes({
      login: [
        lim('login-ip', limits.login, MINUTE),
        makeLimiter(cacheClient, { name: 'login-email', max: limits.loginPerEmail, windowMs: 15 * MINUTE, keyBy: emailKey }),
      ],
      register: lim('register', limits.register, 60 * MINUTE),
    }),
  );
  api.use('/movies', movieRoutes(movies));
  api.use('/theatres', theatreRoutes(theatres));
  api.use('/shows', showRoutes(shows));
  api.use('/bookings', bookingRoutes(bookings, lim('hold', limits.hold, MINUTE, 'user')));
  api.use('/tickets', ticketRoutes(bookings));
  api.use('/payments', paymentRoutes(payments, lim('payment', limits.payment, MINUTE, 'user')));
  api.use('/manager/reports', managerReportRoutes(reports));
  api.use('/manager', managerRoutes(theatres, shows, theatreApprovals, lim('theatre-submit', limits.submit, 60 * MINUTE, 'user')));
  api.use('/admin/reports', adminReportRoutes(reports));
  api.use(
    '/admin',
    adminRoutes({
      movies,
      theatreApprovals,
      media,
      decisionLimiter: lim('admin-actions', limits.admin, MINUTE, 'user'),
      uploadLimiter: lim('upload', limits.upload, MINUTE, 'user'),
    }),
  );
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, cache, cacheClient };
}
